const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, {recursive:true});
const db = new Database(path.join(DATA, "school.db"));
db.pragma("journal_mode=WAL");
db.pragma("foreign_keys=ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,section TEXT DEFAULT '',category TEXT DEFAULT 'Academy',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students(
 id INTEGER PRIMARY KEY AUTOINCREMENT,full_name TEXT NOT NULL,gender TEXT DEFAULT '',
 dob TEXT DEFAULT '',guardian_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT DEFAULT '',
 class_id INTEGER,registration_number TEXT UNIQUE NOT NULL,admission_number TEXT UNIQUE NOT NULL,
 status TEXT DEFAULT 'Active',created_at TEXT NOT NULL,
 FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS teachers(
 id INTEGER PRIMARY KEY AUTOINCREMENT,full_name TEXT NOT NULL,phone TEXT DEFAULT '',
 subject TEXT DEFAULT '',address TEXT DEFAULT '',created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance(
 id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,date TEXT NOT NULL,
 status TEXT NOT NULL,note TEXT DEFAULT '',UNIQUE(student_id,date),
 FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS results(
 id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,term TEXT NOT NULL,
 session TEXT NOT NULL,subject TEXT NOT NULL,ca REAL DEFAULT 0,exam REAL DEFAULT 0,
 total REAL DEFAULT 0,grade TEXT DEFAULT '',remark TEXT DEFAULT '',
 FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS fees(
 id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,amount REAL NOT NULL,
 description TEXT NOT NULL,term TEXT DEFAULT '',session TEXT DEFAULT '',paid_at TEXT NOT NULL,
 FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
`);

// Upgrade older databases created before category support.
try { db.prepare("ALTER TABLE classes ADD COLUMN category TEXT DEFAULT 'Academy'").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }

const now=()=>new Date().toISOString();

// School divisions and their levels.
const classGroups = {
  "Islamiyya": ["Pre-Ibtidaiyya 1", "Pre-Ibtidaiyya 2", "Ibtidaiyya 1", "Ibtidaiyya 2", "Ibtidaiyya 3", "Ibtidaiyya 4", "Ibtidaiyya 5", "Ibtidaiyya 6"],
  "Hifz": ["Hifz 1", "Hifz 2", "Hifz 3", "Hifz 4", "Hifz 5", "Hifz 6"],
  "Academy": ["Nursery 1", "Nursery 2", "Nursery 3", "Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "JSS 1", "JSS 2", "JSS 3", "SS 1", "SS 2", "SS 3"]
};
const insertClass = db.prepare("INSERT OR IGNORE INTO classes(name,section,category,created_at) VALUES(?,?,?,?)");
for (const [category, levels] of Object.entries(classGroups)) {
  for (const level of levels) insertClass.run(level, "", category, now());
}
// Older installations had the first Academy levels without a category. Keep their data, but classify them.
const allowedLevels = Object.values(classGroups).flat();
const placeholders = allowedLevels.map(()=>"?").join(",");
db.prepare(`UPDATE classes SET category=CASE WHEN name IN (${placeholders}) THEN category ELSE 'Legacy' END`).run(...allowedLevels);

const clean=(v,n=300)=>String(v??"").trim().slice(0,n);
const schoolEmail=process.env.SCHOOL_EMAIL||"hallirukidans@gmail.com";
const generalPassword=process.env.GENERAL_PASSWORD||"ChangeThisGeneralPassword";

function nextNumbers(){
  const year=new Date().getFullYear();
  const n=db.prepare("SELECT COUNT(*) n FROM students").get().n+1;
  const serial=String(n).padStart(4,"0");
  return {registrationNumber:`HIK/${year}/${serial}`,admissionNumber:`HIK-${year}-${serial}`};
}
function classLabel(id){
  if(!id)return "";
  const c=db.prepare("SELECT * FROM classes WHERE id=?").get(id);
  return c?c.name+(c.section?" - "+c.section:""):"";
}
function grade(total){
  if(total>=70)return ["A","Excellent"];
  if(total>=60)return ["B","Very Good"];
  if(total>=50)return ["C","Good"];
  if(total>=45)return ["D","Pass"];
  if(total>=40)return ["E","Weak Pass"];
  return ["F","Fail"];
}
function admin(req,res,next){if(!req.session.adminId)return res.status(401).json({error:"Admin login required"});next();}
function student(req,res,next){if(!req.session.studentId)return res.status(401).json({error:"Student login required"});next();}
async function mail(subject,text){
  if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS)return false;
  const t=nodemailer.createTransport({
    host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),
    secure:String(process.env.SMTP_SECURE||"true")==="true",
    auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}
  });
  await t.sendMail({from:process.env.SMTP_USER,to:schoolEmail,subject,text});
  return true;
}

const adminEmail=(process.env.ADMIN_EMAIL||"admin@school.local").toLowerCase();
const configuredAdminName=process.env.ADMIN_NAME||"School Administrator";
const configuredAdminPassword=process.env.ADMIN_PASSWORD||"ChangeThisStrongAdminPassword";
const existingAdmin=db.prepare("SELECT id FROM admins WHERE email=?").get(adminEmail);
if(!existingAdmin){
  db.prepare("INSERT INTO admins(name,email,password_hash,created_at) VALUES(?,?,?,?)")
    .run(configuredAdminName,adminEmail,bcrypt.hashSync(configuredAdminPassword,12),now());
}else if(process.env.ADMIN_PASSWORD){
  // Keep the persistent database in sync with the password configured in Render.
  db.prepare("UPDATE admins SET name=?,password_hash=? WHERE email=?")
    .run(configuredAdminName,bcrypt.hashSync(configuredAdminPassword,12),adminEmail);
}

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex"),
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));
const limiter=rateLimit({windowMs:15*60*1000,limit:40});

app.get("/api/public/classes",(req,res)=>res.json(db.prepare("SELECT * FROM classes WHERE category IN ('Islamiyya','Hifz','Academy') ORDER BY CASE category WHEN 'Islamiyya' THEN 1 WHEN 'Hifz' THEN 2 WHEN 'Academy' THEN 3 ELSE 4 END, id").all()));

app.post("/api/admission",async(req,res)=>{
  const f={
    fullName:clean(req.body.fullName,120),gender:clean(req.body.gender,20),dob:clean(req.body.dob,30),
    guardianName:clean(req.body.guardianName,120),phone:clean(req.body.phone,40),
    address:clean(req.body.address,300),classId:Number(req.body.classId)||null
  };
  if(!f.fullName||!f.guardianName||!f.phone||!f.classId)return res.status(400).json({error:"Please complete all required fields."});
  const n=nextNumbers();
  db.prepare(`INSERT INTO students(full_name,gender,dob,guardian_name,phone,address,class_id,
    registration_number,admission_number,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.fullName,f.gender,f.dob,f.guardianName,f.phone,f.address,f.classId,n.registrationNumber,n.admissionNumber,"Active",now());
  const s=db.prepare("SELECT * FROM students WHERE registration_number=?").get(n.registrationNumber);
  try{await mail(`New Student Registration - ${s.admission_number}`,
`MADARASATUL HAYATUL ISLAM KIDANDAN
New Student Registration

Name: ${s.full_name}
Registration Number: ${s.registration_number}
Admission Number: ${s.admission_number}
Class: ${classLabel(s.class_id)}
Guardian: ${s.guardian_name}
Phone: ${s.phone}
Address: ${s.address}
Registered: ${s.created_at}`);}catch(e){console.error(e.message)}
  res.json({ok:true,student:{fullName:s.full_name,registrationNumber:s.registration_number,admissionNumber:s.admission_number,className:classLabel(s.class_id)},generalPassword});
});

app.post("/api/student/login",limiter,(req,res)=>{
  const reg=clean(req.body.registrationNumber,60),pass=clean(req.body.password,150);
  const s=db.prepare("SELECT * FROM students WHERE registration_number=? AND status='Active'").get(reg);
  if(!s||pass!==generalPassword)return res.status(401).json({error:"Invalid Registration Number or General Password."});
  req.session.studentId=s.id;res.json({ok:true});
});
app.get("/api/student/me",student,(req,res)=>{
  const s=db.prepare(`SELECT s.*,c.name class_name,c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(req.session.studentId);
  const results=db.prepare("SELECT * FROM results WHERE student_id=? ORDER BY session DESC,term,subject").all(s.id);
  const fees=db.prepare("SELECT * FROM fees WHERE student_id=? ORDER BY paid_at DESC").all(s.id);
  const attendance=db.prepare("SELECT * FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 100").all(s.id);
  res.json({student:s,results,fees,attendance});
});
app.post("/api/student/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.post("/api/admin/login",limiter,(req,res)=>{
  const email=clean(req.body.email,150).toLowerCase(),pass=String(req.body.password||"");
  const a=db.prepare("SELECT * FROM admins WHERE email=?").get(email);
  if(!a||!bcrypt.compareSync(pass,a.password_hash))return res.status(401).json({error:"Invalid admin email or password."});
  req.session.adminId=a.id;res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/api/admin/dashboard",admin,(req,res)=>{
  res.json({
    students:db.prepare("SELECT COUNT(*) n FROM students").get().n,
    teachers:db.prepare("SELECT COUNT(*) n FROM teachers").get().n,
    classes:db.prepare("SELECT COUNT(*) n FROM classes").get().n,
    fees:db.prepare("SELECT COALESCE(SUM(amount),0) n FROM fees").get().n
  });
});
app.get("/api/admin/classes",admin,(req,res)=>res.json(db.prepare("SELECT * FROM classes WHERE category IN ('Islamiyya','Hifz','Academy') ORDER BY CASE category WHEN 'Islamiyya' THEN 1 WHEN 'Hifz' THEN 2 WHEN 'Academy' THEN 3 ELSE 4 END, id").all()));
app.post("/api/admin/classes",admin,(req,res)=>{
  try{
    db.prepare("INSERT INTO classes(name,section,category,created_at) VALUES(?,?,?,?)").run(clean(req.body.name,80),clean(req.body.section,50),clean(req.body.category,40)||"Academy",now());
    res.json({ok:true});
  }catch(e){res.status(400).json({error:"Class already exists or is invalid."})}
});
app.get("/api/admin/students",admin,(req,res)=>res.json(db.prepare(`SELECT s.*,c.name class_name,c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id ORDER BY s.id DESC`).all()));
app.post("/api/admin/students",admin,(req,res)=>{
  const n=nextNumbers();
  db.prepare(`INSERT INTO students(full_name,gender,dob,guardian_name,phone,address,class_id,registration_number,admission_number,status,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(clean(req.body.fullName,120),clean(req.body.gender,20),clean(req.body.dob,30),
  clean(req.body.guardianName,120),clean(req.body.phone,40),clean(req.body.address,300),Number(req.body.classId)||null,
  n.registrationNumber,n.admissionNumber,clean(req.body.status,20)||"Active",now());
  res.json({ok:true,registrationNumber:n.registrationNumber,admissionNumber:n.admissionNumber});
});
app.patch("/api/admin/students/:id/status",admin,(req,res)=>{
  db.prepare("UPDATE students SET status=? WHERE id=?").run(clean(req.body.status,20),Number(req.params.id));res.json({ok:true});
});
app.patch("/api/admin/students/:id/class",admin,(req,res)=>{
  const studentId=Number(req.params.id), classId=Number(req.body.classId);
  if(!studentId || !classId || !db.prepare("SELECT id FROM classes WHERE id=?").get(classId)) return res.status(400).json({error:"Invalid student or class."});
  db.prepare("UPDATE students SET class_id=? WHERE id=?").run(classId,studentId);
  const s=db.prepare(`SELECT s.full_name,s.registration_number,c.name class_name,c.category FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(studentId);
  res.json({ok:true,student:s});
});
app.get("/api/admin/teachers",admin,(req,res)=>res.json(db.prepare("SELECT * FROM teachers ORDER BY id DESC").all()));
app.post("/api/admin/teachers",admin,(req,res)=>{
  db.prepare("INSERT INTO teachers(full_name,phone,subject,address,created_at) VALUES(?,?,?,?,?)")
    .run(clean(req.body.fullName,120),clean(req.body.phone,40),clean(req.body.subject,100),clean(req.body.address,300),now());
  res.json({ok:true});
});
app.get("/api/admin/attendance",admin,(req,res)=>{
  const classId=Number(req.query.classId)||0,date=clean(req.query.date,20);
  const students=db.prepare("SELECT id,full_name,registration_number FROM students WHERE class_id=? AND status='Active' ORDER BY full_name").all(classId);
  const rows=db.prepare("SELECT * FROM attendance WHERE date=? AND student_id IN (SELECT id FROM students WHERE class_id=?)").all(date,classId);
  res.json({students,rows});
});
app.post("/api/admin/attendance",admin,(req,res)=>{
  const date=clean(req.body.date,20);
  const list=Array.isArray(req.body.items)?req.body.items:[];
  const st=db.prepare(`INSERT INTO attendance(student_id,date,status,note) VALUES(?,?,?,?)
    ON CONFLICT(student_id,date) DO UPDATE SET status=excluded.status,note=excluded.note`);
  const tx=db.transaction(()=>list.forEach(x=>st.run(Number(x.studentId),date,clean(x.status,20),clean(x.note,200))));
  tx();res.json({ok:true});
});
app.get("/api/admin/results",admin,(req,res)=>{
  const studentId=Number(req.query.studentId)||0;
  res.json(db.prepare("SELECT * FROM results WHERE student_id=? ORDER BY id DESC").all(studentId));
});
app.post("/api/admin/results",admin,(req,res)=>{
  const ca=Math.max(0,Math.min(40,Number(req.body.ca)||0)),exam=Math.max(0,Math.min(60,Number(req.body.exam)||0));
  const total=ca+exam,[g,r]=grade(total);
  db.prepare(`INSERT INTO results(student_id,term,session,subject,ca,exam,total,grade,remark)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(Number(req.body.studentId),clean(req.body.term,30),clean(req.body.session,30),
    clean(req.body.subject,100),ca,exam,total,g,r);
  res.json({ok:true});
});
app.get("/api/admin/fees",admin,(req,res)=>res.json(db.prepare(`SELECT f.*,s.full_name,s.registration_number FROM fees f JOIN students s ON s.id=f.student_id ORDER BY f.id DESC`).all()));
app.post("/api/admin/fees",admin,(req,res)=>{
  db.prepare("INSERT INTO fees(student_id,amount,description,term,session,paid_at) VALUES(?,?,?,?,?,?)")
    .run(Number(req.body.studentId),Number(req.body.amount)||0,clean(req.body.description,150),clean(req.body.term,30),clean(req.body.session,30),now());
  res.json({ok:true});
});
app.get("/api/admin/print/student/:id",admin,(req,res)=>{
  const s=db.prepare(`SELECT s.*,c.name class_name,c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(Number(req.params.id));
  if(!s)return res.status(404).json({error:"Student not found"});
  res.json({student:s});
});
app.get("/health",(req,res)=>res.json({ok:true}));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Madarasatul school system running on http://localhost:${PORT}`));
