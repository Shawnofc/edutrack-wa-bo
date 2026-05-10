const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer-core');
const path = require('path');
require('dotenv').config();

// ---------- Firebase initialization ----------
const serviceAccount = require('./firebase-adminsdk.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'your-project-id.appspot.com' // replace with your bucket
});
const db = admin.firestore();

const app = express();
app.use(express.json());

// ---------- Constants ----------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// In‑memory session store (for demo; for production use Redis)
// Each session stores: { step, schoolId, studentId }
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

// ---------- Main Webhook (Receiving Messages) ----------
app.post('/webhook', async (req, res) => {
  // Acknowledge receipt immediately
  res.sendStatus(200);

  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const from = message.from;
  const text = message.text.body.trim();

  console.log(`[${from}] says: ${text}`);

  // Get or create session for this user
  let session = sessions.get(from) || { step: 'start' };
  await handleMessage(from, text, session);
});

// ---------- Conversation Logic ----------
async function handleMessage(waId, text, session) {
  // Step 1: Initial greeting / show school list
  if (session.step === 'start') {
    const schools = await getAllSchools();
    if (schools.length === 0) {
      await sendText(waId, '❌ No schools found in the system. Please contact support.');
      return;
    }
    const schoolList = schools.map((s, idx) => `${idx+1}. ${s.name}`).join('\n');
    await sendText(waId, `👋 Welcome to EduBot!\n\nPlease select your school by typing the number:\n\n${schoolList}`);
    session.step = 'awaiting_school';
    sessions.set(waId, session);
    return;
  }

  // Step 2: User selects school (by number)
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
    await sendText(waId, `✅ Logged into *${selectedSchool.name}*.\n\nPlease type your Student ID.\nExample: STD-123456`);
    return;
  }

  // Step 3: User provides Student ID
  if (session.step === 'awaiting_student_id') {
    // Student ID format validation (example: STD-123456)
    const studentIdPattern = /^STD-\d{6}$/i;
    if (!studentIdPattern.test(text)) {
      await sendText(waId, '❌ Invalid Student ID format. Please use the format shown (e.g., STD-123456) or contact your school.');
      return;
    }

    const studentId = text.toUpperCase();
    // Look up student in Firestore (must match schoolId)
    const student = await findStudentBySchoolAndId(session.schoolId, studentId);
    if (!student) {
      await sendText(waId, `❌ Student ID *${studentId}* not found in *${session.schoolName}*. Please check and try again.`);
      return;
    }

    // Notify user we are generating
    await sendText(waId, `🔍 Student found: *${student.name}*\n\n📄 Generating report card... Please wait.`);

    // Generate PDF and send
    const pdfBuffer = await generateStudentReportPDF(student, session.schoolName);
    if (!pdfBuffer) {
      await sendText(waId, '❌ Failed to generate report card. Please try again later.');
      return;
    }

    await sendDocument(waId, pdfBuffer, `Report_${student.name.replace(/\s/g, '')}_${studentId}.pdf`);

    // Session ends – reset for next interaction
    sessions.delete(waId);
    await sendText(waId, '✅ Report sent! If you need another, just send "Hi" again.');
    return;
  }
}

// ---------- Helper: Fetch all schools ----------
async function getAllSchools() {
  const snap = await db.collection('schools').get();
  return snap.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
}

// ---------- Helper: Find student by school ID and studentId field ----------
async function findStudentBySchoolAndId(schoolId, studentId) {
  const studentsRef = db.collection('students');
  const q = studentsRef.where('schoolId', '==', schoolId).where('studentId', '==', studentId);
  const snap = await q.get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ---------- PDF Generation (uses Puppeteer) ----------
async function generateStudentReportPDF(student, schoolName) {
  try {
    // Fetch the latest report card for this student
    const reportsRef = db.collection('reports');
    const q = reportsRef.where('studentId', '==', student.id).orderBy('year', 'desc').orderBy('term', 'desc').limit(1);
    const snap = await q.get();
    if (snap.empty) return null;

    const report = snap.docs[0].data();
    const results = (report.subjects || []).map(sub => ({
      subject: sub.name,
      marks: sub.marks,
      grade: calculateGrade(sub.marks, report.form),
      comment: generateComment(sub.marks)
    }));

    const html = buildReportHtml({
      studentName: student.name,
      className: report.form || student.classId || 'Not assigned',
      term: report.term,
      year: report.year,
      results,
      teacherComment: report.teacherComment || '',
      headComment: report.headComment || '',
      schoolName
    });

    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    return pdf;
  } catch (err) {
    console.error('PDF generation error:', err);
    return null;
  }
}

// ---------- HTML template for report card ----------
function buildReportHtml(data) {
  const { studentName, className, term, year, results, teacherComment, headComment, schoolName } = data;
  const rows = results.map(r => `
    <tr>
      <td style="border:1px solid #ddd; padding:8px;">${r.subject}</td>
      <td style="border:1px solid #ddd; padding:8px; text-align:center;">${r.marks}/100</td>
      <td style="border:1px solid #ddd; padding:8px; text-align:center;">${r.grade}</td>
      <td style="border:1px solid #ddd; padding:8px;">${r.comment}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>Report Card</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
    .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 12px; }
    .header { text-align: center; margin-bottom: 20px; }
    .school-name { font-size: 24px; font-weight: bold; color: #4f46e5; }
    .title { font-size: 18px; margin-top: 5px; }
    .details { display: flex; justify-content: space-between; margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f3f4f6; }
    .comment-box { margin: 20px 0; padding: 10px; background: #f9fafb; border-left: 4px solid #4f46e5; }
    .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #6b7280; }
  </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="school-name">${schoolName}</div>
        <div class="title">Student Report Card</div>
      </div>
      <div class="details">
        <div><strong>Name:</strong> ${studentName}</div>
        <div><strong>Class:</strong> ${className}</div>
        <div><strong>Term:</strong> ${term} – Year: ${year}</div>
      </div>
      <table>
        <thead><tr><th>Subject</th><th>Marks</th><th>Grade</th><th>Comment</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="comment-box"><strong>Teacher's Comment:</strong><br/>${teacherComment || '—'}</div>
      <div class="comment-box"><strong>Head Comment:</strong><br/>${headComment || '—'}</div>
      <div class="footer">Generated by EduTrack • WhatsApp Assistant</div>
    </div>
  </body>
  </html>`;
}

// ---------- Grade & comment helpers (same as in your existing system) ----------
function calculateGrade(marks, form) {
  const num = Number(marks);
  if (isNaN(num)) return '-';
  const isAlevel = form?.includes('Form 5') || form?.includes('Form 6');
  if (isAlevel) {
    if (num >= 75) return 'A';
    if (num >= 65) return 'B';
    if (num >= 50) return 'C';
    if (num >= 40) return 'D';
    if (num >= 30) return 'E';
    return 'F';
  } else {
    if (num >= 70) return 'A';
    if (num >= 60) return 'B';
    if (num >= 50) return 'C';
    if (num >= 45) return 'D';
    if (num >= 40) return 'E';
    return 'U';
  }
}

function generateComment(marks) {
  const num = Number(marks);
  if (num >= 90) return 'Excellent';
  if (num >= 75) return 'Very Good';
  if (num >= 60) return 'Good';
  if (num >= 50) return 'Satisfactory';
  if (num >= 40) return 'Needs Improvement';
  return 'Poor Performance';
}

// ---------- WhatsApp API Helpers ----------
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
  // 1. Upload media
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', 'application/pdf');
  formData.append('file', new Blob([buffer]), filename);
  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` },
    body: formData
  });
  const mediaData = await mediaRes.json();
  if (!mediaRes.ok) throw new Error(`Media upload failed: ${JSON.stringify(mediaData)}`);
  const mediaId = mediaData.id;

  // 2. Send document message
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