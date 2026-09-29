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
 dob TEXT DEFAULT '',guardian_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT DEFAULT '', photo TEXT DEFAULT '',
 class_id INTEGER,registration_number TEXT UNIQUE NOT NULL,admission_number TEXT UNIQUE NOT NULL,
 entry_session TEXT DEFAULT '',status TEXT DEFAULT 'Pending',created_at TEXT NOT NULL,
 FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS teachers(
 id INTEGER PRIMARY KEY AUTOINCREMENT,full_name TEXT NOT NULL,phone TEXT DEFAULT '',
 subject TEXT DEFAULT '',address TEXT DEFAULT '',username TEXT UNIQUE,password_hash TEXT DEFAULT '',
 role TEXT DEFAULT 'Teacher',class_ids TEXT DEFAULT '[]',active INTEGER DEFAULT 1,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
 key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS subjects(
 id INTEGER PRIMARY KEY AUTOINCREMENT,subject_name TEXT NOT NULL,class_id INTEGER NOT NULL,active INTEGER DEFAULT 1,created_at TEXT NOT NULL,
 UNIQUE(subject_name,class_id),
 FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS fees(
 id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,amount REAL NOT NULL,
 description TEXT NOT NULL,term TEXT DEFAULT '',session TEXT DEFAULT '',paid_at TEXT NOT NULL,
 FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
`);

// Upgrade older databases created before category support.
try { db.prepare("ALTER TABLE classes ADD COLUMN category TEXT DEFAULT 'Academy'").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE students ADD COLUMN photo TEXT DEFAULT ''").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE students ADD COLUMN entry_session TEXT DEFAULT ''").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE teachers ADD COLUMN username TEXT").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE teachers ADD COLUMN password_hash TEXT DEFAULT ''").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE teachers ADD COLUMN role TEXT DEFAULT 'Teacher'").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE teachers ADD COLUMN class_ids TEXT DEFAULT '[]'").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
try { db.prepare("ALTER TABLE teachers ADD COLUMN active INTEGER DEFAULT 1").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
const now=()=>new Date().toISOString();
const settingGet=(key, fallback='')=>db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback;
const settingSet=(key,value)=>db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key,String(value),now());
if(!db.prepare("SELECT key FROM settings WHERE key='registration_open'").get()) settingSet('registration_open','1');
const defaultAcademicSession=()=>{const y=new Date().getFullYear();return `${y}/${y+1}`};
if(!db.prepare("SELECT key FROM settings WHERE key='registration_session'").get()) settingSet('registration_session',defaultAcademicSession());
// Preserve the original intake session for older students from their existing registration number where possible.
db.prepare("UPDATE students SET entry_session=CASE WHEN entry_session IS NULL OR entry_session='' THEN CASE WHEN registration_number GLOB '*/*/*' THEN substr(registration_number,instr(registration_number,'/')+1,4)||'/'||(CAST(substr(registration_number,instr(registration_number,'/')+1,4) AS INTEGER)+1) ELSE substr(created_at,1,4)||'/'||(CAST(substr(created_at,1,4) AS INTEGER)+1) END ELSE entry_session END WHERE entry_session IS NULL OR entry_session=''").run();
// Students created by the earlier version were considered Active; keep them usable after approval was introduced.
db.prepare("UPDATE students SET status='Approved' WHERE status='Active'").run();


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

function validAcademicSession(value){return /^\d{4}\/\d{4}$/.test(String(value||'')) && Number(String(value).slice(5))===Number(String(value).slice(0,4))+1;}
function nextNumbers(category,session){
  const year=String(session).slice(0,4);
  const prefix=category==="Islamiyya"?"ISL":category==="Hifz"?"HFZ":"ACA";
  const n=db.prepare("SELECT COUNT(*) n FROM students WHERE registration_number LIKE ?").get(`${prefix}/${year}/%`).n+1;
  const serial=String(n).padStart(4,'0');
  return {registrationNumber:`${prefix}/${year}/${serial}`,admissionNumber:`${prefix}-${year}-${serial}`};
}
function classCategory(id){ return db.prepare("SELECT category FROM classes WHERE id=?").get(id)?.category || "Academy"; }
function classSubjects(classId){ return db.prepare("SELECT id,subject_name,class_id,active FROM subjects WHERE class_id=? AND active=1 ORDER BY subject_name").all(Number(classId)); }
function subjectAllowed(classId,subject){ return !!db.prepare("SELECT id FROM subjects WHERE class_id=? AND subject_name=? AND active=1").get(Number(classId),clean(subject,100)); }

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
function teacher(req,res,next){if(!req.session.teacherId)return res.status(401).json({error:"Staff login required"});const t=db.prepare("SELECT * FROM teachers WHERE id=? AND active=1").get(req.session.teacherId);if(!t)return res.status(401).json({error:"Staff account is inactive."});req.teacherAccount=t;next();}
function teacherClasses(t){try{return JSON.parse(t.class_ids||'[]').map(Number).filter(Boolean)}catch{return []}}
function teacherCan(t,role){const r=String(t.role||'Teacher').toLowerCase();return r==='admin' || r===role.toLowerCase() || (role==='Teacher' && r==='teacher') || (role==='Exam Officer' && r==='exam officer') || (role==='Bursar' && r==='bursar');}
function teacherClassAllowed(t,classId){return teacherClasses(t).includes(Number(classId));}
function teacherStudentAllowed(t,studentId){const s=db.prepare("SELECT class_id FROM students WHERE id=?").get(Number(studentId));return !!s && teacherClassAllowed(t,s.class_id);}
function roleOrClass(t,role,classId){return teacherCan(t,role) && teacherClassAllowed(t,classId);}

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
app.use(express.json({limit:"4mb"}));
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex"),
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));
const limiter=rateLimit({windowMs:15*60*1000,limit:40});

app.get("/api/public/classes",(req,res)=>res.json(db.prepare("SELECT * FROM classes WHERE category IN ('Islamiyya','Hifz','Academy') ORDER BY CASE category WHEN 'Islamiyya' THEN 1 WHEN 'Hifz' THEN 2 WHEN 'Academy' THEN 3 ELSE 4 END, id").all()));

app.get("/api/public/settings",(req,res)=>res.json({registrationOpen:settingGet("registration_open","1")==="1",registrationSession:settingGet("registration_session",defaultAcademicSession())}));

app.post("/api/admission",async(req,res)=>{
  if(settingGet("registration_open","1")!=="1")return res.status(403).json({error:"Online student registration is currently closed by the Admin."});
  const f={
    fullName:clean(req.body.fullName,120),gender:clean(req.body.gender,20),dob:clean(req.body.dob,30),
    guardianName:clean(req.body.guardianName,120),phone:clean(req.body.phone,40),
    address:clean(req.body.address,300),photo:clean(req.body.photo,4000000),classId:Number(req.body.classId)||null
  };
  if(!f.fullName||!f.guardianName||!f.phone||!f.classId)return res.status(400).json({error:"Please complete all required fields."});
  const cat=classCategory(f.classId);
  if(!["Islamiyya","Hifz","Academy"].includes(cat))return res.status(400).json({error:"Please select a valid programme."});
  const session=settingGet('registration_session',defaultAcademicSession());
  const n=nextNumbers(cat,session);
  db.prepare(`INSERT INTO students(full_name,gender,dob,guardian_name,phone,address,class_id,
    registration_number,admission_number,entry_session,status,created_at,photo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.fullName,f.gender,f.dob,f.guardianName,f.phone,f.address,f.classId,n.registrationNumber,n.admissionNumber,session,"Pending",now(),f.photo);
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
  res.json({ok:true,student:{fullName:s.full_name,registrationNumber:s.registration_number,admissionNumber:s.admission_number,entrySession:s.entry_session,className:classLabel(s.class_id),programme:cat,status:s.status},generalPassword});
});

app.post("/api/student/login",limiter,(req,res)=>{
  const reg=clean(req.body.registrationNumber,60),pass=clean(req.body.password,150);
  const s=db.prepare("SELECT * FROM students WHERE registration_number=? AND status='Approved'").get(reg);
  if(!s||pass!==generalPassword)return res.status(401).json({error:"Invalid Registration Number or General Password."});
  req.session.studentId=s.id;res.json({ok:true});
});
app.get("/api/student/me",student,(req,res)=>{
  const s=db.prepare(`SELECT s.*,c.name class_name,c.section,c.category programme FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(req.session.studentId);
  const results=db.prepare("SELECT * FROM results WHERE student_id=? ORDER BY session DESC,term,subject").all(s.id);
  const fees=db.prepare("SELECT * FROM fees WHERE student_id=? ORDER BY paid_at DESC").all(s.id);
  const attendance=db.prepare("SELECT * FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 100").all(s.id);
  res.json({student:s,results,fees,attendance});
});
app.post("/api/student/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.post("/api/admin/login",limiter,(req,res)=>{
  const email=clean(req.body.email,150),pass=String(req.body.password||"");
  const a=db.prepare("SELECT * FROM admins WHERE email=?").get(email);
  if(!a||!bcrypt.compareSync(pass,a.password_hash))return res.status(401).json({error:"Invalid admin username or password."});
  req.session.adminId=a.id;res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/api/admin/dashboard",admin,(req,res)=>{
  const byProgramme=db.prepare("SELECT COALESCE(c.category,'Unassigned') programme, COUNT(*) count FROM students s LEFT JOIN classes c ON c.id=s.class_id GROUP BY c.category").all();
  const recent=db.prepare(`SELECT s.id,s.full_name,s.registration_number,s.status,s.created_at,c.name class_name,c.category programme FROM students s LEFT JOIN classes c ON c.id=s.class_id ORDER BY s.id DESC LIMIT 8`).all();
  res.json({
    students:db.prepare("SELECT COUNT(*) n FROM students").get().n,
    approved:db.prepare("SELECT COUNT(*) n FROM students WHERE status='Approved'").get().n,
    pending:db.prepare("SELECT COUNT(*) n FROM students WHERE status='Pending'").get().n,
    rejected:db.prepare("SELECT COUNT(*) n FROM students WHERE status='Rejected'").get().n,
    teachers:db.prepare("SELECT COUNT(*) n FROM teachers").get().n,
    classes:db.prepare("SELECT COUNT(*) n FROM classes WHERE category IN ('Islamiyya','Hifz','Academy')").get().n,
    fees:db.prepare("SELECT COALESCE(SUM(amount),0) n FROM fees").get().n,
    registrationOpen:settingGet("registration_open","1")==="1",
    byProgramme,recent
  });
});
app.get("/api/admin/classes",admin,(req,res)=>res.json(db.prepare("SELECT * FROM classes WHERE category IN ('Islamiyya','Hifz','Academy') ORDER BY CASE category WHEN 'Islamiyya' THEN 1 WHEN 'Hifz' THEN 2 WHEN 'Academy' THEN 3 ELSE 4 END, id").all()));
app.post("/api/admin/classes",admin,(req,res)=>{
  try{
    db.prepare("INSERT INTO classes(name,section,category,created_at) VALUES(?,?,?,?)").run(clean(req.body.name,80),clean(req.body.section,50),clean(req.body.category,40)||"Academy",now());
    res.json({ok:true});
  }catch(e){res.status(400).json({error:"Class already exists or is invalid."})}
});
app.get("/api/admin/students",admin,(req,res)=>res.json(db.prepare(`SELECT s.*,c.name class_name,c.section,c.category programme FROM students s LEFT JOIN classes c ON c.id=s.class_id ORDER BY s.id DESC`).all()));
app.post("/api/admin/students",admin,(req,res)=>{
  const classId=Number(req.body.classId)||null;
  const cat=classCategory(classId);
  const session=settingGet("registration_session",defaultAcademicSession());
  const n=nextNumbers(cat,session);
  db.prepare(`INSERT INTO students(full_name,gender,dob,guardian_name,phone,address,class_id,registration_number,admission_number,entry_session,status,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(clean(req.body.fullName,120),clean(req.body.gender,20),clean(req.body.dob,30),
  clean(req.body.guardianName,120),clean(req.body.phone,40),clean(req.body.address,300),classId,
  n.registrationNumber,n.admissionNumber,session,clean(req.body.status,20)||"Approved",now());
  res.json({ok:true,registrationNumber:n.registrationNumber,admissionNumber:n.admissionNumber});
});
app.patch("/api/admin/students/:id/status",admin,(req,res)=>{
  const status=clean(req.body.status,20);
  if(!["Pending","Approved","Rejected","Inactive"].includes(status))return res.status(400).json({error:"Invalid status."});
  db.prepare("UPDATE students SET status=? WHERE id=?").run(status,Number(req.params.id));res.json({ok:true});
});
app.patch("/api/admin/students/:id/approve",admin,(req,res)=>{
  db.prepare("UPDATE students SET status='Approved' WHERE id=?").run(Number(req.params.id));
  res.json({ok:true});
});
app.patch("/api/admin/students/:id/class",admin,(req,res)=>{
  const studentId=Number(req.params.id), classId=Number(req.body.classId);
  if(!studentId || !classId || !db.prepare("SELECT id FROM classes WHERE id=?").get(classId)) return res.status(400).json({error:"Invalid student or class."});
  db.prepare("UPDATE students SET class_id=? WHERE id=?").run(classId,studentId);
  const s=db.prepare(`SELECT s.full_name,s.registration_number,c.name class_name,c.category FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(studentId);
  res.json({ok:true,student:s});
});
app.get("/api/admin/subjects",admin,(req,res)=>res.json(db.prepare(`SELECT sub.id,sub.subject_name,sub.class_id,sub.active,sub.created_at,c.name class_name,c.category programme FROM subjects sub JOIN classes c ON c.id=sub.class_id ORDER BY c.category,c.id,sub.subject_name`).all()));
app.post("/api/admin/subjects",admin,(req,res)=>{
  const subjectName=clean(req.body.subjectName,100),classId=Number(req.body.classId)||0;
  if(!subjectName||!classId||!db.prepare("SELECT id FROM classes WHERE id=? AND category IN ('Islamiyya','Hifz','Academy')").get(classId)) return res.status(400).json({error:"Subject name and a valid class are required."});
  try{db.prepare("INSERT INTO subjects(subject_name,class_id,active,created_at) VALUES(?,?,1,?)").run(subjectName,classId,now());res.json({ok:true});}
  catch(e){res.status(400).json({error:"This subject is already applied to the selected class."})}
});
app.patch("/api/admin/subjects/:id",admin,(req,res)=>{const id=Number(req.params.id);if(!db.prepare("SELECT id FROM subjects WHERE id=?").get(id))return res.status(404).json({error:"Subject not found."});db.prepare("UPDATE subjects SET active=? WHERE id=?").run(req.body.active===false?0:1,id);res.json({ok:true});});
app.delete("/api/admin/subjects/:id",admin,(req,res)=>{db.prepare("DELETE FROM subjects WHERE id=?").run(Number(req.params.id));res.json({ok:true});});
app.get("/api/admin/class-subjects",admin,(req,res)=>{const classId=Number(req.query.classId)||0;res.json(classSubjects(classId));});
app.get("/api/admin/settings",admin,(req,res)=>res.json({registrationOpen:settingGet("registration_open","1")==="1",registrationSession:settingGet("registration_session",defaultAcademicSession())}));
app.patch("/api/admin/settings/registration",admin,(req,res)=>{settingSet("registration_open",req.body.open?"1":"0");res.json({ok:true,registrationOpen:req.body.open===true});});
app.patch("/api/admin/settings/session",admin,(req,res)=>{const session=clean(req.body.session,20);if(!validAcademicSession(session))return res.status(400).json({error:"Session must be in the form 2026/2027."});settingSet("registration_session",session);res.json({ok:true,registrationSession:session});});
app.get("/api/admin/teachers",admin,(req,res)=>res.json(db.prepare("SELECT id,full_name,phone,subject,address,username,role,class_ids,active,created_at FROM teachers ORDER BY id DESC").all().map(t=>({...t,class_ids:teacherClasses(t)}))));
app.post("/api/admin/teachers",admin,(req,res)=>{
  const fullName=clean(req.body.fullName,120),username=clean(req.body.username,80),password=String(req.body.password||"");
  const role=["Teacher","Exam Officer","Bursar"].includes(req.body.role)?req.body.role:"Teacher";
  const classIds=Array.isArray(req.body.classIds)?req.body.classIds.map(Number).filter(Boolean):[];
  if(!fullName||!username||password.length<8)return res.status(400).json({error:"Full name, username and a password of at least 8 characters are required."});
  try{db.prepare("INSERT INTO teachers(full_name,phone,subject,address,username,password_hash,role,class_ids,active,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)").run(fullName,clean(req.body.phone,40),clean(req.body.subject,100),clean(req.body.address,300),username,bcrypt.hashSync(password,12),role,JSON.stringify(classIds),now());res.json({ok:true});}
  catch(e){res.status(400).json({error:"Username already exists or the staff details are invalid."})}
});
app.patch("/api/admin/teachers/:id",admin,(req,res)=>{
  const id=Number(req.params.id),t=db.prepare("SELECT * FROM teachers WHERE id=?").get(id);if(!t)return res.status(404).json({error:"Staff account not found."});
  const role=["Teacher","Exam Officer","Bursar"].includes(req.body.role)?req.body.role:t.role;const classIds=Array.isArray(req.body.classIds)?req.body.classIds.map(Number).filter(Boolean):teacherClasses(t);
  const password=String(req.body.password||"");
  if(password) db.prepare("UPDATE teachers SET role=?,class_ids=?,active=?,password_hash=? WHERE id=?").run(role,JSON.stringify(classIds),req.body.active===false?0:1,bcrypt.hashSync(password,12),id);
  else db.prepare("UPDATE teachers SET role=?,class_ids=?,active=? WHERE id=?").run(role,JSON.stringify(classIds),req.body.active===false?0:1,id);
  res.json({ok:true});
});
app.post("/api/teacher/login",limiter,(req,res)=>{const username=clean(req.body.username,80),pass=String(req.body.password||"");const t=db.prepare("SELECT * FROM teachers WHERE username=? AND active=1").get(username);if(!t||!t.password_hash||!bcrypt.compareSync(pass,t.password_hash))return res.status(401).json({error:"Invalid staff username or password."});req.session.teacherId=t.id;res.json({ok:true});});
app.post("/api/teacher/logout",(req,res)=>{delete req.session.teacherId;res.json({ok:true});});
app.get("/api/teacher/me",teacher,(req,res)=>{const t=req.teacherAccount;res.json({teacher:{id:t.id,full_name:t.full_name,phone:t.phone,subject:t.subject,username:t.username,role:t.role,active:!!t.active,class_ids:teacherClasses(t)},classes:db.prepare(`SELECT * FROM classes WHERE id IN (${teacherClasses(t).length?teacherClasses(t).join(','):0}) ORDER BY id`).all()});});
app.get("/api/teacher/students",teacher,(req,res)=>{const ids=teacherClasses(req.teacherAccount);if(!ids.length)return res.json([]);res.json(db.prepare(`SELECT s.id,s.full_name,s.gender,s.registration_number,s.admission_number,s.status,s.class_id,c.name class_name,c.category programme FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.class_id IN (${ids.join(',')}) ORDER BY c.id,s.full_name`).all());});
app.get("/api/teacher/attendance",teacher,(req,res)=>{if(!teacherCan(req.teacherAccount,"Teacher"))return res.status(403).json({error:"Only assigned Teachers can manage attendance."});const classId=Number(req.query.classId)||0,date=clean(req.query.date,20);if(!teacherClassAllowed(req.teacherAccount,classId))return res.status(403).json({error:"This class is not assigned to you."});const students=db.prepare("SELECT id,full_name,registration_number FROM students WHERE class_id=? AND status='Approved' ORDER BY full_name").all(classId);const rows=db.prepare("SELECT * FROM attendance WHERE date=? AND student_id IN (SELECT id FROM students WHERE class_id=?)").all(date,classId);res.json({students,rows});});
app.post("/api/teacher/attendance",teacher,(req,res)=>{if(!teacherCan(req.teacherAccount,"Teacher"))return res.status(403).json({error:"Only assigned Teachers can manage attendance."});const classId=Number(req.body.classId)||0;if(!teacherClassAllowed(req.teacherAccount,classId))return res.status(403).json({error:"This class is not assigned to you."});const date=clean(req.body.date,20),list=Array.isArray(req.body.items)?req.body.items:[];const st=db.prepare(`INSERT INTO attendance(student_id,date,status,note) VALUES(?,?,?,?) ON CONFLICT(student_id,date) DO UPDATE SET status=excluded.status,note=excluded.note`);const tx=db.transaction(()=>list.forEach(x=>{if(teacherStudentAllowed(req.teacherAccount,Number(x.studentId)))st.run(Number(x.studentId),date,clean(x.status,20),clean(x.note,200));}));tx();res.json({ok:true});});
app.get("/api/teacher/results",teacher,(req,res)=>{if(!teacherCan(req.teacherAccount,"Exam Officer")&&!teacherCan(req.teacherAccount,"Teacher"))return res.status(403).json({error:"Your role is not allowed to view results."});const ids=teacherClasses(req.teacherAccount);if(!ids.length)return res.json([]);res.json(db.prepare(`SELECT r.*,s.full_name,s.registration_number,s.class_id,c.name class_name FROM results r JOIN students s ON s.id=r.student_id LEFT JOIN classes c ON c.id=s.class_id WHERE s.class_id IN (${ids.join(',')}) ORDER BY s.full_name,r.id DESC`).all());});
app.get("/api/teacher/subjects",teacher,(req,res)=>{const ids=teacherClasses(req.teacherAccount);if(!ids.length)return res.json([]);res.json(db.prepare(`SELECT sub.id,sub.subject_name,sub.class_id,c.name class_name,c.category programme FROM subjects sub JOIN classes c ON c.id=sub.class_id WHERE sub.active=1 AND sub.class_id IN (${ids.join(',')}) ORDER BY c.id,sub.subject_name`).all());});
app.post("/api/teacher/results",teacher,(req,res)=>{const studentId=Number(req.body.studentId),s=db.prepare("SELECT class_id FROM students WHERE id=?").get(studentId),subject=clean(req.body.subject,100);if(!s||!teacherStudentAllowed(req.teacherAccount,studentId)||!teacherCan(req.teacherAccount,"Exam Officer"))return res.status(403).json({error:"Only an assigned Exam Officer can enter results for assigned classes."});if(!subjectAllowed(s.class_id,subject))return res.status(400).json({error:"This subject has not been applied to this class by Admin."});const ca=Math.max(0,Math.min(40,Number(req.body.ca)||0)),exam=Math.max(0,Math.min(60,Number(req.body.exam)||0));const total=ca+exam,[g,r]=grade(total);db.prepare(`INSERT INTO results(student_id,term,session,subject,ca,exam,total,grade,remark) VALUES(?,?,?,?,?,?,?,?,?)`).run(studentId,clean(req.body.term,30),clean(req.body.session,30),subject,ca,exam,total,g,r);res.json({ok:true});});
app.get("/api/teacher/fees",teacher,(req,res)=>{if(!teacherCan(req.teacherAccount,"Bursar"))return res.status(403).json({error:"Only the Bursar can access school fees."});res.json(db.prepare("SELECT f.*,s.full_name,s.registration_number,c.name class_name FROM fees f JOIN students s ON s.id=f.student_id LEFT JOIN classes c ON c.id=s.class_id ORDER BY f.id DESC").all());});
app.post("/api/teacher/fees",teacher,(req,res)=>{const studentId=Number(req.body.studentId);if(!teacherCan(req.teacherAccount,"Bursar")||!teacherStudentAllowed(req.teacherAccount,studentId))return res.status(403).json({error:"Bursar access is limited to assigned classes."});db.prepare("INSERT INTO fees(student_id,amount,description,term,session,paid_at) VALUES(?,?,?,?,?,?)").run(studentId,Number(req.body.amount)||0,clean(req.body.description,150),clean(req.body.term,30),clean(req.body.session,30),now());res.json({ok:true});});
app.get("/api/admin/attendance",admin,(req,res)=>{
  const classId=Number(req.query.classId)||0,date=clean(req.query.date,20);
  const students=db.prepare("SELECT id,full_name,registration_number FROM students WHERE class_id=? AND status='Approved' ORDER BY full_name").all(classId);
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
  const studentId=Number(req.body.studentId),s=db.prepare("SELECT class_id FROM students WHERE id=?").get(studentId),subject=clean(req.body.subject,100);
  if(!s||!subjectAllowed(s.class_id,subject))return res.status(400).json({error:"This subject has not been applied to the student's class. Add it in Subject Management first."});
  const ca=Math.max(0,Math.min(40,Number(req.body.ca)||0)),exam=Math.max(0,Math.min(60,Number(req.body.exam)||0));
  const total=ca+exam,[g,r]=grade(total);
  db.prepare(`INSERT INTO results(student_id,term,session,subject,ca,exam,total,grade,remark) VALUES(?,?,?,?,?,?,?,?,?)`).run(studentId,clean(req.body.term,30),clean(req.body.session,30),subject,ca,exam,total,g,r);
  res.json({ok:true});
});
app.get("/api/admin/fees",admin,(req,res)=>res.json(db.prepare(`SELECT f.*,s.full_name,s.registration_number FROM fees f JOIN students s ON s.id=f.student_id ORDER BY f.id DESC`).all()));
app.post("/api/admin/fees",admin,(req,res)=>{
  db.prepare("INSERT INTO fees(student_id,amount,description,term,session,paid_at) VALUES(?,?,?,?,?,?)")
    .run(Number(req.body.studentId),Number(req.body.amount)||0,clean(req.body.description,150),clean(req.body.term,30),clean(req.body.session,30),now());
  res.json({ok:true});
});
app.get("/api/admin/print/student/:id",admin,(req,res)=>{
  const s=db.prepare(`SELECT s.*,c.name class_name,c.section,c.category programme FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(Number(req.params.id));
  if(!s)return res.status(404).json({error:"Student not found"});
  res.json({student:s});
});
app.get("/health",(req,res)=>res.json({ok:true}));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Madarasatul school system running on http://localhost:${PORT}`));
