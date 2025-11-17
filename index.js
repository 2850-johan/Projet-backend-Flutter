// index.js — serveur & routes
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db'); 
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

// --- Imports de Swagger ---
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

// 🧠 Importe la logique d'appel à l'API Mistral depuis ai.js
const { generateQuiz } = require('./ai'); 

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Init Express
const app = express();
app.use(cors());
app.use(express.json());

// --- Configuration de Swagger ---
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'Quiz App API (Flutter)',
      version: '1.0.0',
      description: 'Documentation de l\'API backend pour l\'application QuizMaster Flutter, gérant l\'authentification, la génération de quiz (Mistral AI) et les scores (MySQL).',
    },
    servers: [
      {
        url: 'http://localhost:3000',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }
      }
    },
    security: [{
      bearerAuth: []
    }]
  },
  apis: ['./index.js'], 
};
const swaggerDocs = swaggerJSDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Logger simple des requêtes
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

// --- Middleware de vérification JWT ---
//Ici on protège les routes qui nécessitent une authentification avec le verificateur de token JWT.
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// -------- ROUTES D'AUTHENTIFICATION --------

/**
 * @swagger
 * /auth/google:
 *   post:
 *     summary: Authentifie un utilisateur via un idToken Google
 *     tags: [Authentification]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Le idToken fourni par Google Sign-In côté Flutter.
 *     responses:
 *       200:
 *         description: Succès - Renvoie un token JWT et les infos utilisateur.
 *       401:
 *         description: idToken Google invalide ou non vérifiable.
 */
app.post('/auth/google', async (req, res) => {
  console.log('📥 Requête /auth/google reçue');
  let idToken = (req.body?.idToken || '').toString().trim();
  const idTokenB64 = (req.body?.idTokenB64 || '').toString().trim();
  if (!idToken && idTokenB64) {
    try { idToken = Buffer.from(idTokenB64, 'base64').toString('utf8'); } catch {}
  }
  console.log('Token reçu (début):', idToken.substring(0, 20));

  try {
    if (!idToken) return res.status(400).json({ error: 'idToken manquant' });
    const parts = idToken.split('.');
    console.log('len=', idToken.length, 'segments=', parts.length);
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const nom = payload.name || (email ? email.split('@')[0] : 'User');
    console.log(`✅ Google auth OK: ${email}`);
    const [rows] = await pool.query(
      'SELECT id_users, nom, email FROM users WHERE google_id = ? OR email = ? LIMIT 1',
      [googleId, email]
    );
    let user;
    if (rows.length) {
      user = rows[0];
      await pool.query(
        'UPDATE users SET google_id = ? WHERE id_users = ? AND google_id IS NULL',
        [googleId, user.id_users]
      );
      console.log('👤 Utilisateur existant mis à jour');
    } else {
      const [r] = await pool.query(
        'INSERT INTO users (nom, email, google_id) VALUES (?, ?, ?)',
        [nom, email, googleId]
      );
      user = { id_users: r.insertId, nom, email };
      console.log('🆕 Nouvel utilisateur créé');
    }
    const accessToken = jwt.sign(
      { uid: user.id_users, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    console.log('🔑 Token JWT généré');
    res.json({ accessToken, expiresIn: 3600, user }); 
  } catch (e) {
    console.error('❌ Auth Google error:', e?.message);
    res.status(401).json({ error: 'idToken invalide ou non vérifiable' });
  }
});

/**
 * @swagger
 * /auth/basic:
 *   post:
 *     summary: Authentifie ou crée un utilisateur avec Nom/Email
 *     tags: [Authentification]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nom:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Succès - Renvoie un token JWT et les infos utilisateur.
 *       400:
 *         description: Nom ou email manquant/invalide.
 */
app.post('/auth/basic', async (req, res) => {
  try {
    const { nom, email } = req.body || {};
    if (!nom || !email) {
      return res.status(400).json({ error: 'nom et email sont requis' });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return res.status(400).json({ error: 'email invalide' });
    const [rows] = await pool.query(
      'SELECT id_users, nom, email FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    let user;
    if (rows.length) {
      user = rows[0];
      if (!user.nom && nom) {
        await pool.query('UPDATE users SET nom = ? WHERE id_users = ?', [nom, user.id_users]);
        user.nom = nom;
      }
    } else {
      const [r] = await pool.query(
        'INSERT INTO users (nom, email) VALUES (?, ?)',
        [nom, email]
      );
      user = { id_users: r.insertId, nom, email };
    }
    const accessToken = jwt.sign(
      { uid: user.id_users, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ accessToken, expiresIn: 3600, user });
  } catch (e) {
    console.error('Auth basic error:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// -------- ROUTE QUIZ (MISTRAL AI) --------

/**
 * @swagger
 * /ai/quiz:
 *   post:
 *     summary: Génère un quiz via Mistral AI (Sécurisé par JWT)
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               theme:
 *                 type: string
 *                 description: Le sujet du quiz (ex 'culture générale').
 *               level:
 *                 type: string
 *                 description: "'facile', 'normal', 'intermediaire', ou 'difficile'."
 *               count:
 *                 type: number
 *                 description: Le nombre de questions demandées.
 *     responses:
 *       200:
 *         description: Renvoie l'objet quiz généré par l'IA.
 *       400:
 *         description: Paramètres (theme, level, count) manquants.
 *       401:
 *         description: Token JWT manquant.
 *       403:
 *         description: Token JWT invalide.
 *       500:
 *         description: Erreur de l'API Mistral (timeout, non-JSON, etc.).
 *       503:
 *         description: Clé API Mistral manquante.
 */
app.post('/ai/quiz', verifyToken, async (req, res) => {
    const { theme, level, count } = req.body || {}; 
    const topic = theme;
    if (!topic || !level || !count) {
        return res.status(400).json({ error: 'Le thème, le niveau et le nombre de questions sont requis.' });
    }
    try {
        console.log(`🧠 Demande de quiz: ${topic} (${level}, ${count} questions) par ${req.user.email}`);
        const quizData = await generateQuiz({ theme: topic, level, count });
        res.json(quizData); 
    } catch (e) {
        console.error('❌ Erreur de génération de quiz:', e?.message || e);
        let status = 500;
        if (e.message.includes('MISTRAL_API_KEY')) status = 503;
        if (e.message.includes('Schéma invalide') || e.message.includes('non-JSON')) status = 500;
        res.status(status).json({ error: 'Échec de la génération du quiz par l\'IA.', details: e.message });
    }
});

// -------- ROUTES UTILISATEURS (CRUD basique) --------

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Récupère la liste de tous les utilisateurs
 *     tags: [Utilisateurs (Admin)]
 *     responses:
 *       200:
 *         description: Une liste d'objets utilisateur.
 */
app.get('/users', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id_users, nom, email FROM users ORDER BY id_users DESC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Crée un nouvel utilisateur (non protégé, pour démo)
 *     tags: [Utilisateurs (Admin)]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nom:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       201:
 *         description: Utilisateur créé.
 */
app.post('/users', async (req, res) => {
  try {
    const { nom, email } = req.body || {};
    if (!nom || !email) return res.status(400).json({ error: 'nom et email sont requis' });
    const [r] = await pool.query(
      'INSERT INTO users (nom, email) VALUES (?, ?)',
      [nom, email]
    );
    res.status(201).json({ id_users: r.insertId, nom, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- ROUTES NIVEAUX (CRUD basique) --------

/**
 * @swagger
 * /level:
 *   get:
 *     summary: Récupère la liste des niveaux de difficulté
 *     tags: [Données (Jeu)]
 *     responses:
 *       200:
 *         description: Une liste des niveaux.
 */
app.get('/level', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id_level, label FROM level ORDER BY id_level ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /level:
 *   post:
 *     summary: Crée un nouveau niveau (pour démo)
 *     tags: [Données (Jeu)]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label:
 *                 type: string
 *                 enum: [facile, normal, intermediaire, difficile]
 *     responses:
 *       201:
 *         description: Niveau créé.
 *       400:
 *         description: Label manquant ou invalide.
 */
app.post('/level', async (req, res) => {
  try {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Le niveau est requis' });
    const allowed = ['facile', 'normal', 'intermediaire', 'difficile'];
    if (!allowed.includes(label)) {
      return res.status(400).json({ error: 'Valeur de niveau invalide' });
    }
    const [r] = await pool.query('INSERT INTO level (label) VALUES (?)', [label]);
    res.status(201).json({ id_level: r.insertId, label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- ROUTES SCORES & CLASSEMENT --------

/**
 * @swagger
 * /score:
 *   get:
 *     summary: Récupère l'historique de tous les scores (brut, ancienne route)
 *     tags: [Scores & Classement]
 *     responses:
 *       200:
 *         description: Une liste de tous les scores enregistrés.
 */
app.get('/score', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id_score, u.nom AS user_nom, l.label AS niveau, s.score
      FROM score s
      JOIN users u ON s.id_users = u.id_users
      LEFT JOIN level l ON s.id_level = l.id_level 
      ORDER BY s.id_score DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /score:
 *   post:
 *     summary: Enregistre le score de l'utilisateur authentifié (Sécurisé par JWT)
 *     tags: [Scores & Classement]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               level:
 *                 type: string
 *               theme:
 *                 type: string
 *               score:
 *                 type: number
 *               totalQuestions:
 *                 type: number
 *     responses:
 *       201:
 *         description: Score enregistré.
 *       401:
 *         description: Token JWT manquant.
 */
app.post('/score', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid; 
    const { level, theme, score, totalQuestions } = req.body || {};

    if (level == null || theme == null || score == null || totalQuestions == null) {
      return res.status(400).json({ error: 'level, theme, score et totalQuestions sont requis.' });
    }

    const [r] = await pool.query(
      'INSERT INTO score (id_users, level_label, theme, score, total_questions) VALUES (?, ?, ?, ?, ?)',
      [userId, level, theme, score, totalQuestions]
    );
    
    res.status(201).json({ id_score: r.insertId, userId, score });

  } catch (e) {
    console.error('Erreur POST /score:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /leaderboard:
 *   get:
 *     summary: Récupère le classement global (Meilleurs scores)
 *     tags: [Scores & Classement]
 *     responses:
 *       200:
 *         description: Renvoie le top 10 des meilleurs scores groupés par utilisateur.
 */
app.get('/leaderboard', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        u.nom AS user_nom, 
        s.level_label AS level,
        MAX(s.score) AS best_score, 
        s.total_questions
      FROM score s
      JOIN users u ON s.id_users = u.id_users
      WHERE s.level_label IS NOT NULL AND s.total_questions IS NOT NULL
      GROUP BY u.nom, s.level_label, s.total_questions
      ORDER BY best_score DESC, u.nom ASC
      LIMIT 10
    `);
    
    const leaderboard = rows.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
    res.json(leaderboard);
  } catch (e) {
    console.error('Erreur GET /leaderboard:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ping
/**
 * @swagger
 * /:
 *   get:
 *     summary: Ping de l'API
 *     tags: [Statut]
 *     responses:
 *       200:
 *         description: '✅ Backend OK'
 */
app.get('/', (_req, res) => res.send('✅ Backend OK'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`📘 Documentation API disponible sur http://localhost:${PORT}/api-docs`);
});