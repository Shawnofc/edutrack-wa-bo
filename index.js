const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pdf = require('html-pdf');
const FormData = require('form-data');
require('dotenv').config();

// ---------- Firebase initialization ----------
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.STORAGE_BUCKET || 'tech-mobiles-f9f4f.appspot.com'
});

const db = admin.firestore();

const app = express();
app.use(express.json());

// ---------- Constants ----------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const sessions = new Map();

// ---------- Webhook Verification ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------- Main Webhook ----------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const from = message.from;
  let text = message.text.body.trim();
  console.log(`[${from}] says: ${text}`);

  // Handle logout in any step
  if (text.toLowerCase() === 'log out') {
    sessions.delete(from);
    await sendText(from, '🔒 You have been logged out.\n\nSend "Hi" to start over. 👋');
    return;
  }

  let session = sessions.get(from) || { step: 'start' };
  await handleMessage(from, text, session);
});

// ---------- Conversation Logic ----------
async function handleMessage(waId, text, session) {
  // Step 1: Show school list
  if (session.step === 'start') {
    const schools = await getAllSchools();
    if (schools.length === 0) {
      await sendText(waId, '❌ No schools found in the system. Please contact support.');
      return;
    }
    const schoolList = schools.map((s, idx) => `${idx+1}. ${s.name}`).join('\n');
    await sendText(waId, `👋 *Welcome to EduTrak Bot!*\n\nI help students download report cards instantly.\n\n📚 *Registered Schools:*\n${schoolList}\n\nPlease select your school by typing the number.\n\n_Example: 1_\n\n━━━━━━━━━━━\n_To log out at any time, type "log out"_`);
    session.step = 'awaiting_school';
    sessions.set(waId, session);
    return;
  }

  // Step 2: User selects school
  if (session.step === 'awaiting_school') {
    const selectedIndex = parseInt(text) - 1;
    const schools = await getAllSchools();
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= schools.length) {
      await sendText(waId, '❌ Invalid number. Please type the number corresponding to your school.');
      return;
    }
    const selectedSchool = schools[selectedIndex];
    session.schoolId = selectedSchool.id;
    session.schoolName = selectedSchool.name;
    session.step = 'awaiting_student_id';
    sessions.set(waId, session);
    await sendText(waId, `✅ *School Selected:* ${selectedSchool.name}\n\nPlease enter your Student ID.\n\n_Format: STD-123456_\n\n_Example: STD-123456_\n\n━━━━━━━━━━━\n_To log out, type "log out"_`);
    return;
  }

  // Step 3: User provides Student ID
  if (session.step === 'awaiting_student_id') {
    const studentIdPattern = /^STD-\d{6}$/i;
    if (!studentIdPattern.test(text)) {
      await sendText(waId, '❌ Invalid Student ID format. Use STD- followed by 6 digits (e.g., STD-123456).');
      return;
    }

    const studentId = text.toUpperCase();
    const student = await findStudentBySchoolAndId(session.schoolId, studentId);
    if (!student) {
      await sendText(waId, `❌ Student ID *${studentId}* not found in *${session.schoolName}*. Please check and try again.`);
      return;
    }

    // Fetch all report cards for this student, sorted by year desc, term desc
    const reports = await getAllReportsForStudent(student.id);
    if (!reports || reports.length === 0) {
      await sendText(waId, `🔍 Student found: *${student.name}*\n\n❌ No report cards available for this student. Please contact your school.`);
      sessions.delete(waId);
      return;
    }

    session.student = student;
    session.reports = reports;
    session.step = 'awaiting_report_selection';
    sessions.set(waId, session);

    // Build report list message
    let reportList = '';
    reports.forEach((r, idx) => {
      reportList += `${idx+1}. ${r.form} - Term ${r.term} - ${r.year}\n`;
    });
    const msg = `🔍 *Student Found:* ${student.name}\n📚 *Class:* ${student.classId || 'Not assigned'}\n\n📄 *Available Report Cards:*\n${reportList}\n\nPlease select the report card you want to download by typing the number.\n\n_Example: 5_\n\n━━━━━━━━━━━\n_To log out, type "log out"_`;
    await sendText(waId, msg);
    return;
  }

  // Step 4: User selects a report
  if (session.step === 'awaiting_report_selection') {
    const selectedIndex = parseInt(text) - 1;
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= session.reports.length) {
      await sendText(waId, '❌ Invalid number. Please type the number of the report you want.');
      return;
    }

    const selectedReport = session.reports[selectedIndex];
    await sendText(waId, '⏳ *Downloading report card, please wait...*');

    // Generate PDF matching the React ReportCard design
    const pdfBuffer = await generateReportCardPDF(session.student, selectedReport, session.schoolId, session.schoolName);
    if (!pdfBuffer) {
      await sendText(waId, '❌ Failed to generate report card. Please try again later.');
      return;
    }

    await sendDocument(waId, pdfBuffer, `Report_${session.student.name.replace(/\s/g, '')}_${selectedReport.form}_Term${selectedReport.term}_${selectedReport.year}.pdf`);

    // End session
    sessions.delete(waId);
    await sendText(waId, '✅ *Report card sent successfully!*\n\nIf you need another report, send "Hi" to start over.\n\n━━━━━━━━━━━\n_To log out, type "log out"_');
    return;
  }
}

// ---------- Helper Functions ----------
async function getAllSchools() {
  const snap = await db.collection('schools').get();
  return snap.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
}

async function findStudentBySchoolAndId(schoolId, studentId) {
  const studentsRef = db.collection('students');
  const q = studentsRef.where('schoolId', '==', schoolId).where('studentId', '==', studentId);
  const snap = await q.get();
  if (snap.empty) return null;
  const student = snap.docs[0].data();
  student.id = snap.docs[0].id;
  return student;
}

async function getAllReportsForStudent(studentId) {
  const reportsRef = db.collection('reports');
  const q = reportsRef.where('studentId', '==', studentId).orderBy('year', 'desc').orderBy('term', 'desc');
  const snap = await q.get();
  return snap.docs.map(doc => doc.data());
}

// Compute subject averages for a given class, form, term, year
async function getSubjectAverages(classId, form, term, year) {
  // Find all students in this class
  const studentsSnap = await db.collection('students').where('classId', '==', classId).get();
  const studentIds = studentsSnap.docs.map(doc => doc.id);
  if (studentIds.length === 0) return {};

  // Find all results for those students, same form, term, year
  const resultsSnap = await db.collection('results')
    .where('studentId', 'in', studentIds)
    .where('form', '==', form)
    .where('term', '==', term)
    .where('year', '==', year)
    .get();

  const subjectSums = {};
  const subjectCounts = {};
  resultsSnap.docs.forEach(doc => {
    const data = doc.data();
    const subj = data.subjectId;
    const marks = data.marksObtained;
    if (!subjectSums[subj]) { subjectSums[subj] = 0; subjectCounts[subj] = 0; }
    subjectSums[subj] += marks;
    subjectCounts[subj] += 1;
  });
  const averages = {};
  Object.keys(subjectSums).forEach(subj => {
    averages[subj] = (subjectSums[subj] / subjectCounts[subj]).toFixed(2);
  });
  return averages;
}

// Generate PDF that looks exactly like the React ReportCard component
async function generateReportCardPDF(student, report, schoolId, schoolName) {
  try {
    // Fetch school details (address, phone, email)
    let schoolDetails = { name: schoolName, address: '', phone: '', email: '' };
    const schoolDoc = await db.collection('schools').doc(schoolId).get();
    if (schoolDoc.exists) {
      const data = schoolDoc.data();
      schoolDetails = { name: data.name || schoolName, address: data.address || '', phone: data.phone || '', email: data.email || '' };
    }

    const form = report.form;
    const term = report.term;
    const year = report.year;
    const subjects = report.subjects || [];
    const results = subjects.map(sub => ({ subject: sub.name, marks: sub.marks }));

    // Compute subject averages for the class
    let subjectAverages = {};
    if (student.classId) {
      subjectAverages = await getSubjectAverages(student.classId, form, term, year);
    }

    // Compute overall totals and passed subjects
    let totalMarks = 0;
    let passedCount = 0;
    const subjectResults = results.map(r => {
      totalMarks += r.marks;
      if (r.marks > 50) passedCount++;
      const avg = subjectAverages[r.subject] || 'N/A';
      const { grade, comment } = getGradeAndComment(r.marks, form);
      return { ...r, avg, grade, comment };
    });
    const overallAverage = (totalMarks / results.length).toFixed(2);
    const totalPossible = results.length * 100;

    // Build HTML identical to React ReportCard
    const html = buildReportCardHTML({
      school: schoolDetails,
      student: { name: student.name, class: form, studentId: student.studentId },
      term,
      year,
      results: subjectResults,
      teacherComment: report.teacherComment || '',
      headComment: report.headComment || '',
      overallAverage,
      totalMarks,
      totalPossible,
      passedCount,
      totalSubjects: results.length
    });

    // Generate PDF buffer
    const pdfBuffer = await new Promise((resolve, reject) => {
      pdf.create(html, { format: 'A4', printBackground: true, border: '0.5in' }).toBuffer((err, buffer) => {
        if (err) reject(err);
        else resolve(buffer);
      });
    });
    return pdfBuffer;
  } catch (err) {
    console.error('PDF generation error:', err);
    return null;
  }
}

function getGradeAndComment(marks, form) {
  const num = Number(marks);
  const isAlevel = form?.includes('Form 5') || form?.includes('Form 6');
  if (isAlevel) {
    if (num >= 75) return { grade: 'A', comment: 'Distinction' };
    if (num >= 65) return { grade: 'B', comment: 'Merit' };
    if (num >= 50) return { grade: 'C', comment: 'Pass' };
    if (num >= 40) return { grade: 'D', comment: 'Satisfactory' };
    if (num >= 30) return { grade: 'E', comment: 'Work Hard' };
    return { grade: 'F', comment: 'Ungraded/Fail' };
  } else {
    if (num >= 70) return { grade: 'A', comment: 'Excellent' };
    if (num >= 60) return { grade: 'B', comment: 'Very Good' };
    if (num >= 50) return { grade: 'C', comment: 'Good' };
    if (num >= 45) return { grade: 'D', comment: 'Satisfactory' };
    if (num >= 40) return { grade: 'E', comment: 'Pass' };
    return { grade: 'U', comment: 'Ungraded' };
  }
}

function buildReportCardHTML(data) {
  const { school, student, term, year, results, teacherComment, headComment, overallAverage, totalMarks, totalPossible, passedCount, totalSubjects } = data;
  const level = student.class?.includes('Form 5') || student.class?.includes('Form 6') ? 'alevel' : 'olevel';
  const rows = results.map(r => `
    <tr>
      <td style="border:1px solid #ddd; padding:6px;">${r.subject}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:center;">${r.marks} / 100</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:center;">${r.avg}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:center;"><span style="padding:2px 6px; border-radius:20px; background:${getGradeColor(r.grade)}; color:white;">${r.grade}</span></td>
      <td style="border:1px solid #ddd; padding:6px;">${r.comment}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>Report Card</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
    .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 12px; }
    .header { text-align: center; border-bottom: 1px solid #ddd; margin-bottom: 15px; }
    .school-name { font-size: 24px; font-weight: bold; color: #4f46e5; }
    .school-details { font-size: 12px; color: #6b7280; }
    .student-details { display: flex; flex-wrap: wrap; justify-content: space-between; background: #f9fafb; padding: 12px; border-radius: 8px; margin-bottom: 20px; }
    .student-detail-item { flex: 1; min-width: 120px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f3f4f6; }
    .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #9ca3af; }
    .signatures { display: flex; justify-content: space-between; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 15px; }
    .signature-item { text-align: center; width: 30%; }
    .grading-legend { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 15px; font-size: 11px; color: #6b7280; }
    .comment-box { margin-top: 15px; background: #f9fafb; padding: 8px; border-left: 4px solid #4f46e5; }
  </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="school-name">${school.name}</div>
        <div class="school-details">${school.address} • ${school.phone} • ${school.email}</div>
        <div style="margin-top:5px;"><strong>Student Report Card</strong></div>
      </div>

      <div class="student-details">
        <div class="student-detail-item"><strong>Name:</strong> ${student.name}</div>
        <div class="student-detail-item"><strong>Form:</strong> ${student.class}</div>
        <div class="student-detail-item"><strong>Student ID:</strong> ${student.studentId}</div>
        <div class="student-detail-item"><strong>Term:</strong> ${term} | <strong>Year:</strong> ${year}</div>
        <div class="student-detail-item"><strong>Overall Avg:</strong> ${overallAverage}%</div>
        <div class="student-detail-item"><strong>Passed Subjects:</strong> ${passedCount} / ${totalSubjects} (≥50%)</div>
      </div>

      <table>
        <thead>
          <tr><th>Subject</th><th>Marks</th><th>Class Avg</th><th>Grade</th><th>Comment</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="2" style="text-align:right"><strong>Total Marks:</strong></td><td colspan="3"><strong>${totalMarks} / ${totalPossible}</strong></td></tr>
          <tr><td colspan="2" style="text-align:right"><strong>Overall Percentage:</strong></td><td colspan="3"><strong>${overallAverage}%</strong></td></tr>
        </tfoot>
      </table>

      <div class="comment-box"><strong>Teacher's Comment:</strong><br/>${teacherComment || '—'}</div>
      <div class="comment-box"><strong>Head Comment:</strong><br/>${headComment || '—'}</div>

      <div class="signatures">
        <div class="signature-item">Teacher's Signature<br/><div style="border-bottom:1px solid #000; width:80%; margin:5px auto; height:30px;"></div></div>
        <div class="signature-item">Head's Signature<br/><div style="border-bottom:1px solid #000; width:80%; margin:5px auto; height:30px;"></div></div>
        <div class="signature-item">School Stamp<br/><div style="border:1px solid #000; width:50px; height:50px; margin:5px auto; text-align:center; line-height:50px;">STAMP</div></div>
      </div>

      <div class="grading-legend">
        ${level === 'olevel' 
          ? '<span>A=70-100</span><span>B=60-69</span><span>C=50-59</span><span>D=45-49</span><span>E=40-44</span><span>U=0-39</span>'
          : '<span>A=75-100</span><span>B=65-74</span><span>C=50-64</span><span>D=40-49</span><span>E=30-39</span><span>F=0-29</span>'}
      </div>
      <div class="footer">Generated by EduTrak • ${new Date().toLocaleString()}</div>
    </div>
  </body>
  </html>`;
}

function getGradeColor(grade) {
  switch(grade) {
    case 'A': return '#22c55e';
    case 'B': return '#3b82f6';
    case 'C': return '#eab308';
    case 'D': return '#f97316';
    case 'E': return '#f97316';
    default: return '#ef4444';
  }
}

// ---------- WhatsApp API Helpers (unchanged) ----------
async function sendText(to, message) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message }
  };
  await callWhatsAppAPI(url, payload);
}

async function sendDocument(to, buffer, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', buffer, { filename });

  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      ...form.getHeaders()
    },
    body: form
  });
  const mediaData = await mediaRes.json();
  if (!mediaRes.ok) throw new Error(`Media upload failed: ${JSON.stringify(mediaData)}`);
  const mediaId = mediaData.id;

  const msgUrl = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id: mediaId, filename, caption: '📄 Your report card' }
  };
  await callWhatsAppAPI(msgUrl, payload);
}

async function callWhatsAppAPI(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp API error: ${err}`);
  }
  console.log('Message sent');
}

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));