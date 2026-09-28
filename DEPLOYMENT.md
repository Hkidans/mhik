# Deployment — Madarasatul Hayatul Islam Kidandan

## 1. Local test
Install Node.js LTS, then:
npm install
copy .env.example .env
npm start

Open: http://localhost:3000

Admin login:
- Email: value of ADMIN_EMAIL
- Password: value of ADMIN_PASSWORD

Students:
- Register at /#admission
- Login at /#student with Registration Number + GENERAL_PASSWORD

## 2. Production hosting
Use a VPS or a Node.js hosting provider with persistent disk. Upload this folder, run `npm install`, configure `.env`, and start with `npm start`.

For a domain, point DNS to the server, then put Nginx/Caddy in front of Node and enable HTTPS.

For a VPS, PM2 is useful:
npm install -g pm2
pm2 start server.js --name madarasatul-school
pm2 save

## 3. Email
To send notifications to hallirukidans@gmail.com, configure SMTP. For Gmail, use a dedicated school Gmail account and a Gmail App Password, not the normal Gmail password.

## 4. Production security
- Change ADMIN_PASSWORD, GENERAL_PASSWORD and SESSION_SECRET.
- Use HTTPS.
- Back up data/school.db.
- Restrict admin access.
- Do not upload .env.
- Consider PostgreSQL for a very large school.


### Latest fixes
- Session cookies are configured to work correctly behind Render's HTTPS proxy.
- Starter classes/levels are seeded automatically on first startup.
- Node.js is pinned to 24.21.0 and better-sqlite3 to 12.x.
