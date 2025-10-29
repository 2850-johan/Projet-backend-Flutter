//fichier qui gère le serveur et les routes, genre tout ce qui est principal au projet.
// Fait par Johan et Rodney


//Ici on importe les modules nécessaires pour le serveur.
//express qui gere  le serveru web , cors pour les requetes cross-origin , et le pool de connexion a la base de données.
const express = require('express');
const cors = require('cors');
const {pool} = require('./db');
require('dotenv').config();

//ici on initialise le serveur express
const app = express();
app.use(cors());
app.use(express.json());

//-----------USERS ROUTES -----------------
// Routes users (exemples simples) avec des get et post pour récupérer et ajouter des utilisateurs
//ce get lui permet de demander la liste des utilisateurs à la base de données
app.get('/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id_users, nom, email FROM users ORDER BY id_users DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//ce post lui permet d'ajouter un utilisateur à la base de données
//il vérifie aussi que le nom et l'email sont fournis dans le corps de la requête
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
    // gestion email unique, etc.
    res.status(500).json({ error: e.message });
  }
});


//-----------LEVEL ROUTES -----------------
// Routes level (exemples simples) avec des get et post pour récupérer et ajouter des niveaux
//ce get lui permet de demander la liste des niveaux à la base de données.
app.get('/level', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id_level, label FROM level ORDER BY id_level ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//ce post lui permet d'ajouter un niveau à la base de données
//il vérifie aussi que le label est fourni dans le corps de la requête
app.post('/level', async (req, res) => {
  try {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Le niveau est requis' });

    // On vérifie que le label fait partie des valeurs autorisées
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

//-----------SCORES ROUTES -----------------

// Routes score (exemples simples) avec des get pour récupérer les scores
//ce get lui permet de demander la liste des scores à la base de données avec les jointures pour avoir le nom de l'utilisateur et le label du niveau
//il ordonne les scores par id_score décroissant pour avoir les plus récents en premier
app.get('/score', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        s.id_score,
        u.nom AS user_nom,
        l.label AS niveau,
        s.score
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


//ce get lui permet de demander la liste des scores d'un utilisateur spécifique à la base de données
//il utilise l'id_users passé en paramètre d'URL pour filtrer les scores
app.get('/score/:id_users', async (req, res) => {
  try {
    const { id_users } = req.params;
    const [rows] = await pool.query(`
      SELECT 
        s.id_score,
        l.label AS niveau,
        s.score
      FROM score s
      JOIN level l ON s.id_level = l.id_level
      WHERE s.id_users = ?
      ORDER BY s.id_score DESC
    `, [id_users]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Aucun score trouvé pour cet utilisateur.' });
    }

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//ce post lui permet d'ajouter un score à la base de données
// il vérifie aussi que id_users, id_level et score sont fournis dans le corps de la requête
app.post('/score', async (req, res) => {
  try {
    const { id_users, id_level, score } = req.body || {};
    if (!id_users || !id_level || score == null) {
      return res.status(400).json({ error: 'id_users, id_level et score sont requis.' });
    }

    const [r] = await pool.query(`
      INSERT INTO score (id_users, id_level, score)
      VALUES (?, ?, ?)
    `, [id_users, id_level, score]);

    res.status(201).json({ 
      message: 'Score ajouté avec succès.',
      id_score: r.insertId, 
      id_users, 
      id_level, 
      score 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


//test
app.get('/', (req, res) => res.send('OK'));


//-----------SERVER START -----------------
//ici on démarre le serveur sur le port défini dans le fichier .env ou 3000 par défaut

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));