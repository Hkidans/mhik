# Madarasatul Hayatul Islam Kidandan — Full School Management System

Address: Anguwan Kawo Kidandan, Giwa Local Government
Motto: تعلم العلم للعلم

Included:
- School public website and supplied logo
- Online admission
- Automatic Registration Number and Admission Number
- Student portal
- Admin portal
- Students
- Teachers
- Classes
- Attendance
- Results and automatic grades
- Fees
- Email notification to hallirukidans@gmail.com
- SQLite persistent database
- Hashed admin password
- Session login
- Rate limiting and security headers
- Responsive mobile layout

See DEPLOYMENT.md for launch instructions.

## New Role-Based Features
- Admin can open or close online student registration from the Admin Dashboard.
- When registration is closed, the public admission form is hidden and the server rejects new admission submissions.
- Admin can create staff accounts with a unique username and hashed password.
- Staff roles: Teacher, Exam Officer, Bursar.
- Admin assigns one or more classes to each staff account.
- Teacher portal: view assigned students and manage attendance for assigned classes.
- Exam Officer portal: enter/view results only for assigned classes.
- Bursar portal: record school fee payments only for assigned classes.
- Staff permissions are enforced by the server, not only by the browser interface.
