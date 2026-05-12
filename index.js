const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer-core');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
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

// ---------- Helper: Find Chromium executable (Render compatible) ----------
function getChromiumExecutablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cacheDir)) {
    const platforms = fs.readdirSync(cacheDir);
    for (const platform of platforms) {
      const exePath = path.join(cacheDir, platform, 'chrome-linux64', 'chrome');
      if (fs.existsSync(exePath)) return exePath;
    }
  }
  const commonPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chromium executable not found');
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

// ---------- PDF Generation using Puppeteer with exact sample HTML ----------
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

    // Build HTML exactly like the sample, with TailwindCDN
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

    // Launch Puppeteer
    const browser = await puppeteer.launch({
      executablePath: getChromiumExecutablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
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

// ---------- Build exactly the sample HTML structure ----------
function buildReportCardHTML(data) {
  const { school, studentName, studentClass, studentId, term, year, results, teacherComment, headComment, overallAverage, totalMarks, totalPossible, passed, totalSubjects, level } = data;

  // Generate rows
  let tableRows = '';
  for (const r of results) {
    const badgeColor = getBadgeColor(r.grade);
    tableRows += `
      <tr class="result-row border-b hover:bg-gray-50 transition">
        <td class="px-2 py-2 border-b text-gray-800 font-medium">${escapeHtml(r.subject)}</td>
        <td class="px-2 py-2 border-b">${r.marks} / 100</td>
        <td class="px-2 py-2 border-b">${r.avg}</td>
        <td class="px-2 py-2 border-b">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${badgeColor}">${r.grade}</span>
        </td>
        <td class="px-2 py-2 border-b text-gray-500 italic">${r.comment}</td>
      </tr>
    `;
  }

  const footerRows = `
    <tfoot class="bg-gray-50 text-sm">
      <tr class="border-t">
        <td colspan="4" class="px-2 py-2 text-right font-semibold text-gray-700">Total Marks</td>
        <td class="px-2 py-2 font-semibold text-gray-800">${totalMarks} / ${totalPossible}</td>
      </tr>
      <tr class="border-t">
        <td colspan="4" class="px-2 py-2 text-right font-semibold text-gray-700">Overall Percentage</td>
        <td class="px-2 py-2 font-semibold text-gray-800">${overallAverage}%</td>
      </tr>
      <tr class="border-t">
        <td colspan="4" class="px-2 py-2 text-right font-semibold text-gray-700">Subjects Passed</td>
        <td class="px-2 py-2 font-semibold text-gray-800">${passed} / ${totalSubjects} (≥50%)</td>
      </tr>
    </tfoot>
  `;

  const legendItems = level === 'olevel' 
    ? `<span>A=70-100</span><span>B=60-69</span><span>C=50-59</span><span>D=45-49</span><span>E=40-44</span><span>U=0-39</span>`
    : `<span>A=75-100</span><span>B=65-74</span><span>C=50-64</span><span>D=40-49</span><span>E=30-39</span><span>F=0-29</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>EduTrack | Student Report Card</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @media print {
            body * { visibility: hidden; }
            .report-print-area, .report-print-area * { visibility: visible; }
            .report-print-area { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; }
            .no-print { display: none !important; }
            table, tr, td, th { page-break-inside: avoid; }
            .print-border-fix { border: 1px solid #e5e7eb; }
        }
        .report-card-table td, .report-card-table th { border-color: #e5e7eb; }
        .result-row:hover { background-color: #f9fafb; transition: 0.1s; }
    </style>
</head>
<body class="bg-gray-100 py-6 px-4 font-sans antialiased">
    <div class="max-w-5xl mx-auto">
        <div class="report-print-area">
            <div class="bg-white rounded-xl shadow-lg overflow-hidden print:shadow-none border border-gray-100">
                <div class="p-5 md:p-6 print:p-4">
                    <!-- School Header -->
                    <div class="text-center border-b border-gray-200 pb-3 mb-4">
                        <h2 class="text-2xl font-extrabold text-gray-800 tracking-tight">${escapeHtml(school.name)}</h2>
                        ${school.address ? `<p class="text-gray-600 text-xs mt-0.5">${escapeHtml(school.address)}</p>` : ''}
                        ${school.phone ? `<p class="text-gray-500 text-xs">${escapeHtml(school.phone)}</p>` : ''}
                        ${school.email ? `<p class="text-gray-500 text-xs">${escapeHtml(school.email)}</p>` : ''}
                    </div>

                    <!-- Student Details Grid -->
                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 bg-gray-50 p-3 rounded-lg mb-5 text-sm">
                        <div><p class="text-xs text-gray-500">Student Name</p><p class="font-bold text-gray-800">${escapeHtml(studentName)}</p></div>
                        <div><p class="text-xs text-gray-500">Class</p><p class="font-bold text-gray-800">${escapeHtml(studentClass)}</p></div>
                        <div><p class="text-xs text-gray-500">Student ID</p><p class="font-bold text-gray-800">${escapeHtml(studentId)}</p></div>
                        <div><p class="text-xs text-gray-500">Term</p><p class="font-bold text-gray-800">${term}</p></div>
                        <div><p class="text-xs text-gray-500">Year</p><p class="font-bold text-gray-800">${year}</p></div>
                        <div><p class="text-xs text-gray-500">Overall Avg</p><p class="font-bold text-gray-800">${overallAverage}%</p></div>
                    </div>

                    <!-- Results Table -->
                    <div class="overflow-x-auto mb-5">
                        <table class="min-w-full text-xs border border-gray-200 rounded-md report-card-table">
                            <thead class="bg-gray-100">
                                <tr>
                                    <th class="px-2 py-2 text-left font-semibold text-gray-700">Subject</th>
                                    <th class="px-2 py-2 text-left font-semibold text-gray-700">Marks</th>
                                    <th class="px-2 py-2 text-left font-semibold text-gray-700">Class Avg</th>
                                    <th class="px-2 py-2 text-left font-semibold text-gray-700">Grade</th>
                                    <th class="px-2 py-2 text-left font-semibold text-gray-700">Comment</th>
                                </tr>
                            </thead>
                            <tbody>${tableRows}</tbody>
                            ${footerRows}
                        </table>
                    </div>

                    <!-- Comments -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 text-sm">
                        <div>
                            <p class="text-xs font-semibold text-gray-600 uppercase tracking-wide">Teacher's Comment</p>
                            <div class="border border-gray-200 rounded-lg p-2.5 min-h-[70px] bg-gray-50 text-gray-700 leading-relaxed">${escapeHtml(teacherComment) || ''}</div>
                        </div>
                        <div>
                            <p class="text-xs font-semibold text-gray-600 uppercase tracking-wide">Head's Comment</p>
                            <div class="border border-gray-200 rounded-lg p-2.5 min-h-[70px] bg-gray-50 text-gray-700 leading-relaxed">${escapeHtml(headComment) || ''}</div>
                        </div>
                    </div>

                    <!-- Signatures & Stamp -->
                    <div class="flex flex-wrap justify-between items-end mt-5 pt-3 border-t border-gray-200 text-xs">
                        <div class="text-center w-28">
                            <p class="text-gray-500 text-xs">Teacher's Signature</p>
                            <div class="mt-1 w-full border-b border-gray-400 h-6"></div>
                        </div>
                        <div class="text-center w-28">
                            <p class="text-gray-500 text-xs">Head's Signature</p>
                            <div class="mt-1 w-full border-b border-gray-400 h-6"></div>
                        </div>
                        <div class="text-center">
                            <div class="w-12 h-12 border-2 border-gray-400 rounded-md mx-auto flex items-center justify-center text-gray-500 text-xs font-mono">STAMP</div>
                            <p class="text-xs text-gray-500 mt-1">Official Stamp</p>
                        </div>
                    </div>

                    <!-- Grading Legend -->
                    <div class="mt-4 pt-2 border-t border-gray-200 text-xs text-gray-500 flex flex-wrap gap-3 justify-center">
                        ${legendItems}
                    </div>
                    <div class="text-center text-gray-400 text-[11px] mt-3">
                        Generated on ${new Date().toLocaleDateString()} – EduTrack
                    </div>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function getBadgeColor(grade) {
  switch(grade) {
    case 'A': return 'bg-green-100 text-green-800';
    case 'B': return 'bg-blue-100 text-blue-800';
    case 'C': return 'bg-yellow-100 text-yellow-800';
    case 'D': return 'bg-orange-100 text-orange-800';
    case 'E': return 'bg-orange-100 text-orange-800';
    default: return 'bg-red-100 text-red-800';
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

// ---------- WhatsApp API Helpers (unchanged) ----------
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