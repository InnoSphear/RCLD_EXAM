const Groq = require('groq-sdk');
const { env } = require('../config/env');

function getGroqClient() {
  if (!env.GROQ_API_KEY) {
    return null;
  }
  return new Groq({ apiKey: env.GROQ_API_KEY });
}

function buildPrompt(text) {
  return `You are an expert exam question parser. Your task is to extract all questions from the given text in a clean, structured format.

Rules:
- Extract ALL questions, including multiple choice, true/false, fill-in-the-blank, and descriptive questions
- For MCQ questions, extract ALL options with their labels (a, b, c, d, e etc.)
- Identify the correct answer(s) precisely - for MCQ, return the option key(s) (a,b,c,...). For MSQ (multiple select), return multiple keys. For True/False, return "true" or "false". For fill-in-blanks, return the exact answer text.
- If there is no explicit answer found, DO NOT invent one - mark as needing review
- Preserve the exact question statement (cleaned up)
- Detect if it's MCQ (single answer), MSQ (multiple answers), TF (true/false), FILL (fill in blank), or DESCRIPTIVE
- Include marks if mentioned, otherwise default to 1
- Include explanation if present

Return ONLY a valid JSON array of questions with this exact schema:
[{
  "type": "mcq|msq|tf|fill|descriptive",
  "statement": "full question text",
  "options": [{"key": "a", "text": "option text"}],
  "correctAnswers": ["a"],
  "explanation": "explanation text or empty string",
  "marks": 1,
  "negativeMarks": 0
}]

If no questions found, return empty array [].

Text to parse:
${text}`;
}

async function parseQuestionsWithAI(text, model) {
  const client = getGroqClient();
  if (!client) {
    throw new Error('Groq API key not configured. Please set GROQ_API_KEY in environment.');
  }

  try {
    const completion = await client.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a precise exam question extractor. Always return valid JSON only.'
        },
        {
          role: 'user',
          content: buildPrompt(text)
        }
      ],
      model: model || env.GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from AI');
    }

    let parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed.questions && Array.isArray(parsed.questions)) {
      return parsed.questions;
    }
    return [];
  } catch (error) {
    throw new Error(`AI parsing failed: ${error.message}`);
  }
}

module.exports = { parseQuestionsWithAI, getGroqClient };
