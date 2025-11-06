// ai.js – Appels à l’API Mistral pour générer des questions
const axios = require('axios');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';
const MISTRAL_TIMEOUT = Number(process.env.MISTRAL_TIMEOUT_MS || 7 0000);

/**
 * Construit un prompt clair + contrainte JSON stricte.
 */
function buildSystemPrompt(theme, level, count) {
  return `
Tu es un générateur de quiz concis et fiable. Ton objectif est de générer un tableau JSON STRICTEMENT conforme au schéma requis.
Thème: ${theme}
Niveau: ${level} (facile|normal|intermediaire|difficile)
Nombre de questions: ${count}

RENVOIE STRICTEMENT un JSON (pas de texte autour), au format:
{
  "questions": [
    {
      "question": "…",
      "choices": ["…","…","…","…"],
      "answer": 0,
      "explanation": "…"
    }
  ]
}

Règles:
- "choices" doit contenir **exactement 4** propositions.
- "answer" est l'index (0..3) de la bonne réponse.
- Pas de balises markdown, pas de commentaires, pas de texte hors JSON.
- Questions courtes, factuelles, adaptées au niveau.
`;
}

/**
 * Appelle Mistral (endpoint type OpenAI-compatible /chat/completions).
 * Retourne { questions: [...] }
 */
async function generateQuiz({ theme, level, count }) {
  if (!MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY manquant dans .env');
  }

  const payload = {
    model: MISTRAL_MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user',   content: buildSystemPrompt(theme, level, count) }
    ],
    temperature: 0.4,
    max_tokens: 1200,
    //  CORRECTION CLÉ : Forcer la sortie du modèle au format JSON
    response_format: { type: 'json_object' }, 
  };

  try {
    const resp = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      payload,
      {
        timeout: MISTRAL_TIMEOUT,
        headers: {
          'Authorization': `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = resp?.data?.choices?.[0]?.message?.content || '';
    
    // On parse et on valide minimalement.
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      // 💡 On renvoie le texte brut pour le débogage si le JSON échoue toujours
      throw new Error(`Réponse Mistral non-JSON. Ajuste le prompt/temperature. Réponse brute: ${text}`); 
    }

    // Validation rapide
    if (!data.questions || !Array.isArray(data.questions)) {
      throw new Error('Schéma invalide: "questions" manquant.');
    }
    for (const q of data.questions) {
      if (
        typeof q.question !== 'string' ||
        !Array.isArray(q.choices) || q.choices.length !== 4 ||
        typeof q.answer !== 'number' || q.answer < 0 || q.answer > 3
      ) {
        throw new Error('Schéma question invalide (question/choices/answer).');
      }
      // Normalisation optionnelle
      q.explanation = q.explanation || '';
    }

    return data; // { questions: [...] }
  } catch (error) {
    // Si Axios échoue (timeout, 401, 500)
    if (axios.isAxiosError(error)) {
        console.error('Erreur Axios:', error.response?.data || error.message);
        throw new Error(`Erreur API: ${error.response?.data?.error?.message || error.message}`);
    }
    throw error; // Renvoie l'erreur originale (validation ou autre)
  }
}

module.exports = { generateQuiz };