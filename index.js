// index.js — serveur & routes
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db'); // <-- ton db.js existant (mysql2/promise)
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

// 🧠 Importe la logique d'appel à l'API Mistral depuis ai.js
const { generateQuiz } = require('./ai'); 

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Init Express
const app = express();
app.use(cors());
app.use(express.json());

// Logger simple des requêtes
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

// -------- AUTH GOOGLE --------
app.post('/auth/google', async (req, res) => {
  console.log('📥 Requête /auth/google reçue');

  // On accepte soit { idToken }, soit { idTokenB64 } (sécurise transport si besoin)
  let idToken = (req.body?.idToken || '').toString().trim();
  const idTokenB64 = (req.body?.idTokenB64 || '').toString().trim();
  if (!idToken && idTokenB64) {
    try { idToken = Buffer.from(idTokenB64, 'base64').toString('utf8'); } catch {}
  }

  console.log('Token reçu (début):', idToken.substring(0, 20));

  try {
    if (!idToken) return res.status(400).json({ error: 'idToken manquant' });

    // Petit debug local (compter les segments A.B.C)
    const parts = idToken.split('.');
    console.log('len=', idToken.length, 'segments=', parts.length);

    // Vérification du jeton côté Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload(); // sub, email, name, ...
    const googleId = payload.sub;
    const email = payload.email;
    const nom = payload.name || (email ? email.split('@')[0] : 'User');

    console.log(`✅ Google auth OK: ${email}`);

    // Upsert user (chercher par google_id, ou par email)
    const [rows] = await pool.query(
      'SELECT id_users, nom, email FROM users WHERE google_id = ? OR email = ? LIMIT 1',
      [googleId, email]
    );

    let user;
    if (rows.length) {
      user = rows[0];
      // Lier google_id si manquant
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

    // Générer TON JWT (pour protéger tes autres routes)
//ici on permet d'avoir le nom dans le token  AINI que l'email et l'id
//
    const accessToken = jwt.sign(
      { uid: user.id_users, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }// on ordonne le temps d'expiration du token ici à 1 heure
    );
    console.log('🔑 Token JWT généré');

    res.json({ accessToken, expiresIn: 3600, user }); // on renvoie aussi le user info, 
  } catch (e) {
    console.error('❌ Auth Google error:', e?.message || e);//ici on verifie si le token est valide et est indentique à celui de google.
    res.status(401).json({ error: 'idToken invalide ou non vérifiable' });
  }
});
// --- Auth basique (nom + email) ---
app.post('/auth/basic', async (req, res) => {
  try {
    const { nom, email } = req.body || {};
    if (!nom || !email) {
      return res.status(400).json({ error: 'nom et email sont requis' });
    }

    // mini validation email
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return res.status(400).json({ error: 'email invalide' });

    // on cherche par email (unique)
    const [rows] = await pool.query(
      'SELECT id_users, nom, email FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    let user;
    if (rows.length) {
      user = rows[0];
      // si le nom est vide ou différent, on le met à jour gentiment
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

    // émet un JWT comme pour Google
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

// -------- MISTRAL AI (Génération de Quiz) --------
app.post('/ai/quiz', async (req, res) => {
    // Récupère les données envoyées par Flutter : theme, level, count
    const { theme, level, count } = req.body || {}; 
    const topic = theme; // Utiliser 'theme' comme sujet

    if (!topic || !level || !count) {
        return res.status(400).json({ error: 'Le thème, le niveau et le nombre de questions sont requis.' });
    }

    try {
        console.log(`🧠 Demande de quiz: ${topic} (${level}, ${count} questions)`);

        // Appel à la logique Mistral encapsulée dans ai.js
        const quizData = await generateQuiz({ theme: topic, level, count });

        // Votre fonction generateQuiz retourne déjà { questions: [...] }
        res.json(quizData); 

    } catch (e) {
        console.error('❌ Erreur de génération de quiz:', e?.message || e);
        
        // Gérer spécifiquement les erreurs d'API ou de validation
        let status = 500;
        if (e.message.includes('MISTRAL_API_KEY')) status = 503;
        if (e.message.includes('Schéma invalide') || e.message.includes('non-JSON')) status = 500;
        
        res.status(status).json({ error: 'Échec de la génération du quiz par l\'IA.', details: e.message });
    }
});


// -------- USERS --------
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

// -------- LEVEL --------
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

// -------- SCORE (exemples) --------
app.get('/score', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id_score, u.nom AS user_nom, l.label AS niveau, s.score
      FROM score s
      JOIN users u ON s.id_users = u.id_users
      JOIN level l ON s.id_level = l.id_level
      ORDER BY s.id_score DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/score', async (req, res) => {
  try {
    const { id_users, id_level, score } = req.body || {};
    if (!id_users || !id_level || score == null) {
      return res.status(400).json({ error: 'id_users, id_level et score sont requis.' });
    }
    const [r] = await pool.query(
      'INSERT INTO score (id_users, id_level, score) VALUES (?, ?, ?)',
      [id_users, id_level, score]
    );
    res.status(201).json({ id_score: r.insertId, id_users, id_level, score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- ROUTES Classement --------
// index.js

// -------- LEADERBOARD (Classement Global) --------
// Renvoie le MEILLEUR score de chaque utilisateur
app.get('/leaderboard', async (req, res) => {
  try {
    // Note : Nous simplifions. Le code React calcule un score total complexe avec bonus de temps.
    // Nous allons d'abord classer par le 'score' simple (bonnes réponses).
    // Vous devrez d'abord AJOUTER les colonnes 'theme', 'total_questions', 'level_label' à votre table 'score'
    
    const [rows] = await pool.query(`
      SELECT 
        u.nom AS user_nom, 
        s.level_label AS level,
        MAX(s.score) AS best_score, 
        s.total_questions
      FROM score s
      JOIN users u ON s.id_users = u.id_users
      GROUP BY u.nom, s.level_label, s.total_questions
      ORDER BY best_score DESC, u.nom ASC
      LIMIT 10
    `);
    
    // Ajout du rang (similaire à la logique React)
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
app.get('/', (_req, res) => res.send('✅ Backend OK'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});