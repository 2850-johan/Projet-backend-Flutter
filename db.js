//fichier de configuration de la base de données 
// Fait par Johan et Rodney
// db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'quiz_user',
  password: process.env.DB_PASS || 'quiz_pass',
  database: process.env.DB_NAME || 'quiz_app',
  connectionLimit: 10,
});

module.exports = { pool };
