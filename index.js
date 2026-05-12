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

  if (text.toLowerCase() === 'log out') {
    sessions.delete(from);
    await sendText(from, '🔒 Logged out.\n\nSend "Hi" to start over.');
    return;
  }

  let session = sessions.get(from) || { step: 'start' };
  await handleMessage(from, text, session);
});

// ---------- Conversation Logic (unchanged) ----------
async function handleMessage(waId, text, session) {
  if (session.step === 'start') {
    const schools = await getAllSchools();
    if (schools.length === 0) {
      await sendText(waId, '❌ No schools found.');
      return;
    }
    const schoolList = schools.map((s, idx) => `${idx+1}. ${s.name}`).join('\n');
    await sendText(waId, `👋 *EduTrak Bot*\n\nSelect your school by typing the number:\n\n${schoolList}\n\n_Type "log out" to exit._`);
    session.step = 'awaiting_school';
    sessions.set(waId, session);
    return;
  }

  if (session.step === 'awaiting_school') {
    const selectedIndex = parseInt(text) - 1;
    const schools = await getAllSchools();
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= schools.length) {
      await sendText(waId, '❌ Invalid number. Try again.');
      return;
    }
    const selectedSchool = schools[selectedIndex];
    session.schoolId = selectedSchool.id;
    session.schoolName = selectedSchool.name;
    session.step = 'awaiting_student_id';
    sessions.set(waId, session);
    await sendText(waId, `✅ *${selectedSchool.name}*\n\nEnter your Student ID.\n_Format: STD-123456_\n\n_Type "log out" to exit._`);
    return;
  }

  if (session.step === 'awaiting_student_id') {
    const studentIdPattern = /^STD-\d{6}$/i;
    if (!studentIdPattern.test(text)) {
      await sendText(waId, '❌ Invalid ID. Use STD-123456.');
      return;
    }
    const studentId = text.toUpperCase();
    const student = await findStudentBySchoolAndId(session.schoolId, studentId);
    if (!student) {
      await sendText(waId, `❌ Student ID ${studentId} not found in ${session.schoolName}.`);
      return;
    }
    const reports = await getAllReportsForStudent(student.id);
    if (!reports.length) {
      await sendText(waId, `🔍 Student found: *${student.name}*\n\n❌ No report cards available.`);
      sessions.delete(waId);
      return;
    }
    session.student = student;
    session.reports = reports;
    session.step = 'awaiting_report_selection';
    sessions.set(waId, session);
    let list = '';
    reports.forEach((r, i) => { list += `${i+1}. ${r.form} - Term ${r.term} - ${r.year}\n`; });
    await sendText(waId, `✅ *${student.name}*\n\n📄 Available reports:\n${list}\n\nType the number of the report you want.`);
    return;
  }

  if (session.step === 'awaiting_report_selection') {
    const idx = parseInt(text) - 1;
    if (isNaN(idx) || idx < 0 || idx >= session.reports.length) {
      await sendText(waId, '❌ Invalid number. Try again.');
      return;
    }
    const report = session.reports[idx];
    await sendText(waId, '⏳ Generating report card...');
    const pdfBuffer = await generateReportCardPDF(session.student, report, session.schoolId);
    if (!pdfBuffer) {
      await sendText(waId, '❌ Failed to generate PDF. Try again later.');
      return;
    }
    await sendDocument(waId, pdfBuffer, `Report_${session.student.name.replace(/\s/g, '')}_${report.form}_Term${report.term}_${report.year}.pdf`);
    sessions.delete(waId);
    await sendText(waId, '✅ Report sent! Send "Hi" for another.');
    return;
  }
}

// ---------- Firestore Helpers ----------
async function getAllSchools() {
  const snap = await db.collection('schools').get();
  return snap.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
}

async function findStudentBySchoolAndId(schoolId, studentId) {
  const q = db.collection('students').where('schoolId', '==', schoolId).where('studentId', '==', studentId);
  const snap = await q.get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  data.id = snap.docs[0].id;
  return data;
}

async function getAllReportsForStudent(studentId) {
  const snap = await db.collection('reports').where('studentId', '==', studentId).orderBy('year', 'desc').orderBy('term', 'desc').get();
  return snap.docs.map(doc => doc.data());
}

// ---------- Subject Averages (for "Class Avg") ----------
async function getSubjectAverages(classId, form, term, year) {
  const students = await db.collection('students').where('classId', '==', classId).get();
  const studentIds = students.docs.map(d => d.id);
  if (!studentIds.length) return {};
  const resultsSnap = await db.collection('results')
    .where('studentId', 'in', studentIds)
    .where('form', '==', form)
    .where('term', '==', term)
    .where('year', '==', year)
    .get();
  const sums = {}, counts = {};
  resultsSnap.docs.forEach(doc => {
    const { subjectId, marksObtained } = doc.data();
    if (!sums[subjectId]) sums[subjectId] = 0, counts[subjectId] = 0;
    sums[subjectId] += marksObtained;
    counts[subjectId]++;
  });
  const averages = {};
  Object.keys(sums).forEach(subject => { averages[subject] = (sums[subject] / counts[subject]).toFixed(2); });
  return averages;
}

// ---------- PDF Generation using html-pdf (with embedded CSS) ----------
async function generateReportCardPDF(student, report, schoolId) {
  try {
    // Fetch school details
    const schoolDoc = await db.collection('schools').doc(schoolId).get();
    const school = schoolDoc.exists ? schoolDoc.data() : { name: 'School', address: '', phone: '', email: '' };

    const form = report.form;
    const term = report.term;
    const year = report.year;
    const subjects = report.subjects || [];
    const results = subjects.map(sub => ({ subject: sub.name, marks: sub.marks }));
    const classAverages = await getSubjectAverages(student.classId, form, term, year);

    const level = form?.includes('Form 5') || form?.includes('Form 6') ? 'alevel' : 'olevel';
    let totalMarks = 0, passed = 0;
    const detailedResults = results.map(r => {
      totalMarks += r.marks;
      if (r.marks >= 50) passed++;
      const { grade, comment } = getGradeAndComment(r.marks, level);
      const avg = classAverages[r.subject] || 'N/A';
      return { ...r, grade, comment, avg };
    });
    const overallAverage = results.length ? (totalMarks / results.length).toFixed(2) : 0;
    const totalPossible = results.length * 100;

    const html = buildReportHTML({
      school,
      studentName: student.name,
      studentClass: form,
      studentId: student.studentId,
      term,
      year,
      results: detailedResults,
      teacherComment: report.teacherComment || '',
      headComment: report.headComment || '',
      overallAverage,
      totalMarks,
      totalPossible,
      passed,
      totalSubjects: results.length,
      level
    });

    // Convert HTML to PDF using html-pdf
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

function getGradeAndComment(marks, level) {
  const num = Number(marks);
  if (isNaN(num)) return { grade: '-', comment: '' };
  if (level === 'olevel') {
    if (num >= 70) return { grade: 'A', comment: 'Excellent' };
    if (num >= 60) return { grade: 'B', comment: 'Very Good' };
    if (num >= 50) return { grade: 'C', comment: 'Good' };
    if (num >= 45) return { grade: 'D', comment: 'Satisfactory' };
    if (num >= 40) return { grade: 'E', comment: 'Pass' };
    return { grade: 'U', comment: 'Ungraded' };
  } else {
    if (num >= 75) return { grade: 'A', comment: 'Distinction' };
    if (num >= 65) return { grade: 'B', comment: 'Merit' };
    if (num >= 50) return { grade: 'C', comment: 'Pass' };
    if (num >= 40) return { grade: 'D', comment: 'Satisfactory Pass' };
    if (num >= 30) return { grade: 'E', comment: 'Work Hard' };
    return { grade: 'F', comment: 'Ungraded / Fail' };
  }
}

function getGradeBadgeClass(grade) {
  switch(grade) {
    case 'A': return 'bg-green-100 text-green-800';
    case 'B': return 'bg-blue-100 text-blue-800';
    case 'C': return 'bg-yellow-100 text-yellow-800';
    case 'D': return 'bg-orange-100 text-orange-800';
    case 'E': return 'bg-orange-100 text-orange-800';
    default: return 'bg-red-100 text-red-800';
  }
}

// ---------- Build HTML with embedded CSS (identical to sample, no external dependencies) ----------
function buildReportHTML(data) {
  const { school, studentName, studentClass, studentId, term, year, results, teacherComment, headComment, overallAverage, totalMarks, totalPossible, passed, totalSubjects, level } = data;

  const tableRows = results.map(r => `
    <tr class="result-row">
      <td style="border:1px solid #e5e7eb; padding:8px; font-weight:500; color:#1f2937;">${escapeHtml(r.subject)}</td>
      <td style="border:1px solid #e5e7eb; padding:8px; text-align:center;">${r.marks} / 100</td>
      <td style="border:1px solid #e5e7eb; padding:8px; text-align:center;">${r.avg}</td>
      <td style="border:1px solid #e5e7eb; padding:8px; text-align:center;">
        <span style="display:inline-block; padding:2px 8px; border-radius:9999px; font-size:0.75rem; font-weight:600; background:${getGradeColor(r.grade)}; color:white;">${r.grade}</span>
      </td>
      <td style="border:1px solid #e5e7eb; padding:8px; color:#6b7280; font-style:italic;">${r.comment}</td>
    </tr>
  `).join('');

  const footerRows = `
    <tr style="background:#f9fafb;">
      <td colspan="4" style="border:1px solid #e5e7eb; padding:8px; text-align:right; font-weight:600;">Total Marks</td>
      <td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">${totalMarks} / ${totalPossible}</td>
    </tr>
    <tr style="background:#f9fafb;">
      <td colspan="4" style="border:1px solid #e5e7eb; padding:8px; text-align:right; font-weight:600;">Overall Percentage</td>
      <td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">${overallAverage}%</td>
    </tr>
    <tr style="background:#f9fafb;">
      <td colspan="4" style="border:1px solid #e5e7eb; padding:8px; text-align:right; font-weight:600;">Subjects Passed</td>
      <td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">${passed} / ${totalSubjects} (≥50%)</td>
    </tr>
  `;

  const legend = level === 'olevel'
    ? `<span>A=70-100</span> <span>B=60-69</span> <span>C=50-59</span> <span>D=45-49</span> <span>E=40-44</span> <span>U=0-39</span>`
    : `<span>A=75-100</span> <span>B=65-74</span> <span>C=50-64</span> <span>D=40-49</span> <span>E=30-39</span> <span>F=0-29</span>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>EduTrack Report Card</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f3f4f6; padding: 20px; }
  .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); overflow: hidden; }
  .content { padding: 1.5rem; }
  .school-header { text-align: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.75rem; margin-bottom: 1rem; }
  .school-name { font-size: 1.5rem; font-weight: 800; color: #1f2937; letter-spacing: -0.5px; }
  .school-details { font-size: 0.7rem; color: #6b7280; margin-top: 0.2rem; }
  .student-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 0.75rem; background: #f9fafb; padding: 0.75rem; border-radius: 0.5rem; margin-bottom: 1.25rem; }
  .student-item p:first-child { font-size: 0.7rem; color: #6b7280; }
  .student-item p:last-child { font-weight: 700; color: #1f2937; }
  table { width: 100%; border-collapse: collapse; font-size: 0.75rem; margin-bottom: 1.25rem; }
  th { background: #f3f4f6; text-align: left; padding: 8px; border: 1px solid #e5e7eb; font-weight: 600; }
  .comment-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
  .comment-box { border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 0.5rem; background: #f9fafb; }
  .comment-title { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: #4b5563; margin-bottom: 0.25rem; }
  .comment-text { font-size: 0.75rem; color: #374151; line-height: 1.4; }
  .signatures { display: flex; justify-content: space-between; margin-top: 1.25rem; padding-top: 0.75rem; border-top: 1px solid #e5e7eb; }
  .signature { text-align: center; width: 30%; }
  .stamp { width: 50px; height: 50px; border: 2px solid #9ca3af; border-radius: 0.375rem; margin: 0 auto; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: #6b7280; }
  .legend { margin-top: 1rem; padding-top: 0.5rem; border-top: 1px solid #e5e7eb; font-size: 0.65rem; color: #6b7280; text-align: center; display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
  .footer { text-align: center; font-size: 0.6rem; color: #9ca3af; margin-top: 0.75rem; }
  @media print {
    body { background: white; padding: 0; }
    .container { box-shadow: none; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="content">
    <!-- School Header -->
    <div class="school-header">
      <div class="school-name">${escapeHtml(school.name)}</div>
      ${school.address ? `<div class="school-details">${escapeHtml(school.address)}</div>` : ''}
      ${school.phone ? `<div class="school-details">${escapeHtml(school.phone)}</div>` : ''}
      ${school.email ? `<div class="school-details">${escapeHtml(school.email)}</div>` : ''}
    </div>

    <!-- Student Details -->
    <div class="student-grid">
      <div class="student-item"><p>Student Name</p><p>${escapeHtml(studentName)}</p></div>
      <div class="student-item"><p>Class</p><p>${escapeHtml(studentClass)}</p></div>
      <div class="student-item"><p>Student ID</p><p>${escapeHtml(studentId)}</p></div>
      <div class="student-item"><p>Term</p><p>${term}</p></div>
      <div class="student-item"><p>Year</p><p>${year}</p></div>
      <div class="student-item"><p>Overall Avg</p><p>${overallAverage}%</p></div>
    </div>

    <!-- Results Table -->
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th>Marks</th>
          <th>Class Avg</th>
          <th>Grade</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
      <tfoot>${footerRows}</tfoot>
    </table>

    <!-- Comments -->
    <div class="comment-grid">
      <div class="comment-box"><div class="comment-title">Teacher's Comment</div><div class="comment-text">${escapeHtml(teacherComment) || '—'}</div></div>
      <div class="comment-box"><div class="comment-title">Head's Comment</div><div class="comment-text">${escapeHtml(headComment) || '—'}</div></div>
    </div>

    <!-- Signatures & Stamp -->
    <div class="signatures">
      <div class="signature"><div>Teacher's Signature</div><div style="border-bottom:1px solid #9ca3af; margin-top:5px; height:30px;"></div></div>
      <div class="signature"><div>Head's Signature</div><div style="border-bottom:1px solid #9ca3af; margin-top:5px; height:30px;"></div></div>
      <div class="signature"><div class="stamp">STAMP</div><div style="font-size:10px;">Official Stamp</div></div>
    </div>

    <!-- Grading Legend -->
    <div class="legend">${legend}</div>
    <div class="footer">Generated on ${new Date().toLocaleDateString()} – EduTrack</div>
  </div>
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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// ---------- WhatsApp API Helpers ----------
async function sendText(to, message) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } };
  await callWhatsAppAPI(url, payload);
}

async function sendDocument(to, buffer, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', buffer, { filename });
  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, ...form.getHeaders() },
    body: form
  });
  const mediaData = await mediaRes.json();
  if (!mediaRes.ok) throw new Error(`Media upload failed: ${JSON.stringify(mediaData)}`);
  const mediaId = mediaData.id;
  const msgUrl = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, filename, caption: '📄 Your report card' } };
  await callWhatsAppAPI(msgUrl, payload);
}

async function callWhatsAppAPI(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`WhatsApp API error: ${err}`); }
  console.log('Message sent');
}

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));