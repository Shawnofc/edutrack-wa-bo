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

// ---------- Helper: get current term and year ----------
function getCurrentTermYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = Jan
  let term = '1';
  if (month >= 3 && month <= 6) term = '2';  // Apr–Jul
  else if (month >= 7) term = '3';          // Aug–Dec
  return { term, year };
}

// ---------- Helper: get student fee balance ----------
async function getStudentFeeBalance(studentId) {
  try {
    const studentRef = db.collection('students').doc(studentId);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) return null;
    const balance = studentSnap.data().feeBalance || 0;
    return balance;
  } catch (error) {
    console.error('Error fetching fee balance:', error);
    return null;
  }
}

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

// ---------- Conversation Logic ----------
async function handleMessage(waId, text, session) {
  // Help command (available at any step after student is known)
  const lowerText = text.toLowerCase();
  if (lowerText === 'help') {
    let helpMsg = '📚 *EduTrak Bot Help*\n\n';
    if (session.student) {
      helpMsg += '✅ You are logged in.\n';
      helpMsg += '• Send a number to download a report card.\n';
      helpMsg += '• Send BALANCE to check your fee balance.\n';
      helpMsg += '• Send LOG OUT to end session.\n';
    } else {
      helpMsg += '1. Select your school by typing its number.\n';
      helpMsg += '2. Enter your Student ID (e.g., STD-123456).\n';
      helpMsg += '3. Choose a report card number to download.\n';
      helpMsg += '4. Send BALANCE to check fee balance.\n';
      helpMsg += '5. Send LOG OUT at any time.\n';
    }
    await sendText(waId, helpMsg);
    return;
  }

  // Balance command – only works after student is identified
  if (lowerText === 'balance' && session.student) {
    const { term, year } = getCurrentTermYear();
    const balance = await getStudentFeeBalance(session.student.id);
    if (balance === null) {
      await sendText(waId, '❌ Could not retrieve fee balance. Please try again later.');
    } else {
      const balanceMsg = `💰 *Fee Balance for ${session.student.name}*\n\nTerm: ${term}\nYear: ${year}\nOutstanding balance: $${balance.toFixed(2)}\n\nTo download a report card, type the number of the report.`;
      await sendText(waId, balanceMsg);
    }
    return;
  }

  // Original flow continues...
  if (session.step === 'start') {
    const schools = await getAllSchools();
    if (schools.length === 0) {
      await sendText(waId, '❌ No schools found.');
      return;
    }
    const schoolList = schools.map((s, idx) => `${idx+1}. ${s.name}`).join('\n');
    await sendText(waId, `👋 *EduTrak Bot*\n\nSelect your school by typing the number:\n\n${schoolList}\n\n_Type "HELP" for commands, "LOG OUT" to exit._`);
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
    await sendText(waId, `✅ *${selectedSchool.name}*\n\nEnter your Student ID.\n_Format: STD-123456_\n\n_Type "HELP" for commands._`);
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
    await sendText(waId, `✅ *${student.name}*\n\n📄 Available reports:\n${list}\n\nType the number of the report you want.\n\n_You can also type "BALANCE" to check fees._`);
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

// ---------- Subject Averages ----------
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

// ---------- PDF Generation (unchanged) ----------
async function generateReportCardPDF(student, report, schoolId) {
  try {
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

    const html = buildReportCardHTML({
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

    const pdfBuffer = await new Promise((resolve, reject) => {
      pdf.create(html, { format: 'A4', printBackground: true, border: '0.4in' }).toBuffer((err, buffer) => {
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
    if (num >= 40) return { grade: 'D', comment: 'Satisfactory' };
    if (num >= 30) return { grade: 'E', comment: 'Work Hard' };
    return { grade: 'F', comment: 'Ungraded' };
  }
}

function buildReportCardHTML(data) {
  const { school, studentName, studentClass, studentId, term, year, results, teacherComment, headComment, overallAverage, totalMarks, totalPossible, passed, totalSubjects, level } = data;

  let tableRows = '';
  for (const r of results) {
    tableRows += `
      <tr>
        <td style="border:1px solid #ddd; padding:4px; font-size:10px;">${escapeHtml(r.subject)}</td>
        <td style="border:1px solid #ddd; padding:4px; text-align:center; font-size:10px;">${r.marks} / 100</td>
        <td style="border:1px solid #ddd; padding:4px; text-align:center; font-size:10px;">${r.avg}</td>
        <td style="border:1px solid #ddd; padding:4px; text-align:center; font-size:10px;"><strong>${r.grade}</strong></td>
        <td style="border:1px solid #ddd; padding:4px; font-size:10px;">${r.comment}</td>
      </tr>
    `;
  }

  const legend = level === 'olevel'
    ? 'A=70-100 | B=60-69 | C=50-59 | D=45-49 | E=40-44 | U=0-39'
    : 'A=75-100 | B=65-74 | C=50-64 | D=40-49 | E=30-39 | F=0-29';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>EduTrack Report Card</title>
<style>
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    margin: 0;
    padding: 0;
    font-size: 10px;
  }
  .container {
    max-width: 800px;
    margin: 0 auto;
    background: white;
    padding: 10px;
  }
  .header {
    text-align: center;
    border-bottom: 2px solid #4f46e5;
    padding-bottom: 6px;
    margin-bottom: 12px;
  }
  .school-name {
    font-size: 18px;
    font-weight: bold;
    color: #1f2937;
  }
  .school-details {
    font-size: 9px;
    color: #6b7280;
  }
  .student-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    background: #f9fafb;
    padding: 8px;
    border-radius: 6px;
    margin-bottom: 12px;
    font-size: 9px;
  }
  .student-item p:first-child {
    font-weight: 600;
    margin-bottom: 2px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  th, td {
    border: 1px solid #ddd;
    padding: 4px;
    font-size: 9px;
  }
  th {
    background-color: #f3f4f6;
    text-align: left;
  }
  .comment-box {
    margin: 8px 0;
    padding: 6px;
    background: #f9fafb;
    border-left: 3px solid #4f46e5;
    font-size: 9px;
  }
  .signatures {
    display: flex;
    justify-content: space-between;
    margin-top: 15px;
    padding-top: 8px;
    border-top: 1px solid #ddd;
    font-size: 8px;
  }
  .signature {
    text-align: center;
    width: 30%;
  }
  .stamp {
    width: 45px;
    height: 45px;
    border: 1px solid #9ca3af;
    border-radius: 4px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
  }
  .legend {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid #ddd;
    font-size: 8px;
    text-align: center;
    color: #6b7280;
  }
  .footer-note {
    margin-top: 12px;
    text-align: center;
    font-size: 7px;
    color: #9ca3af;
    background: #fef3c7;
    padding: 4px;
    border-radius: 4px;
  }
  .footer-note a {
    color: #4f46e5;
    text-decoration: none;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="school-name">${escapeHtml(school.name)}</div>
    ${school.address ? `<div class="school-details">${escapeHtml(school.address)}</div>` : ''}
    ${school.phone ? `<div class="school-details">${escapeHtml(school.phone)}</div>` : ''}
    ${school.email ? `<div class="school-details">${escapeHtml(school.email)}</div>` : ''}
  </div>

  <div class="student-grid">
    <div class="student-item"><p>Student Name</p><p>${escapeHtml(studentName)}</p></div>
    <div class="student-item"><p>Class</p><p>${escapeHtml(studentClass)}</p></div>
    <div class="student-item"><p>Student ID</p><p>${escapeHtml(studentId)}</p></div>
    <div class="student-item"><p>Term</p><p>${term}</p></div>
    <div class="student-item"><p>Year</p><p>${year}</p></div>
    <div class="student-item"><p>Overall Avg</p><p>${overallAverage}%</p></div>
  </div>

  <table>
    <thead><tr><th>Subject</th><th>Marks</th><th>Class Avg</th><th>Grade</th><th>Comment</th></tr></thead>
    <tbody>${tableRows}</tbody>
    <tfoot>
      <tr><td colspan="4" style="text-align:right;"><strong>Total Marks:</strong></td><td><strong>${totalMarks} / ${totalPossible}</strong></td></tr>
      <tr><td colspan="4" style="text-align:right;"><strong>Overall Percentage:</strong></td><td><strong>${overallAverage}%</strong></td></tr>
      <tr><td colspan="4" style="text-align:right;"><strong>Subjects Passed</strong></td><td><strong>${passed} / ${totalSubjects}</strong></td></tr>
    </tfoot>
  </table>

  <div class="comment-box"><strong>Teacher's Comment</strong><br/>${escapeHtml(teacherComment) || '—'}</div>
  <div class="comment-box"><strong>Head's Comment</strong><br/>${escapeHtml(headComment) || '—'}</div>

  <div class="signatures">
    <div class="signature">Teacher's Signature<br/><div style="border-bottom:1px solid #000; margin-top:5px; height:25px;"></div></div>
    <div class="signature">Head's Signature<br/><div style="border-bottom:1px solid #000; margin-top:5px; height:25px;"></div></div>
    <div class="signature"><div class="stamp">STAMP</div><div>Official Stamp</div></div>
  </div>

  <div class="legend">Grading System: ${legend}</div>
  <div class="footer-note">
    📄 This is a digital copy. To download the original report card, please log in to your EduTrack account at 
    <a href="https://edutrack4.netlify.app">https://edutrack4.netlify.app</a>
  </div>
</div>
</body>
</html>`;
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
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id: mediaId, filename, caption: '📄 This is a digital copy. To download the original report card, please log in to your EduTrack account at https://edutrack4.netlify.app' }
  };
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