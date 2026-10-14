/**
 * Deterministic question parser.
 * Converts raw text (from PDF/DOCX/CSV) into structured question objects.
 *
 * Supported patterns:
 *   1. Question statement...        1) or Q1. or 1.
 *      a) Option one
 *      b) Option two
 *      Answer: b) Option two
 *
 *   - True/False statements with "Answer: True/False"
 *   - Fill-in-the-blank with answer choices
 *   - Questions/options spanning multiple paragraphs
 *   - Section headings like "A.", "B." are ignored when they are alone on a line
 *     and followed by a numbered question.
 *
 * Answer-integrity rules:
 *   - Never invents a correct answer; missing answers are flagged.
 *   - If the answer letter does not match an existing option, it is flagged.
 *   - If answer text does not match any option text, letter is kept only when
 *     the letter is valid; the mismatch is flagged for review.
 */

const OPTION_RE = /^\s*[\*•]?\s*[\(\[]?([a-hA-H])[\)\.\]:]\s+(.*)$/;
const QUESTION_RE = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[\.\)\:]\s+(.*)$/;
const ANSWER_RE = /^\s*(?:Source\s+)?(?:Ans(?:wer)?|Correct\s*(?:Answer|Option)|Solution)\s*[\:\-\.]\s*(.*)$/i;
const EXPLANATION_RE = /^\s*(?:Explanation|Solution|Discuss(?:ion)?)\s*[:\-]?\s+(.*)$/i;
const SECTION_RE = /^\s*([A-Z])\s*[\.\)]\s*$/;
const ANSWER_KEY_HEADING_RE = /^\s*(?:answer\s*key|answer\s*sheet|correct\s*answers?|answers?)\s*[:\-]?\s*(.*)$/i;
const INLINE_OPTION_RE = /(?:^|\s)\(?([a-hA-H])[\)\.\:](?=\s)/g;
const TRAILING_KEY_LINE_RE = /^(?:\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[\.\)\:\-]?\s*(?:[a-h]|true|false))+$/i;
const ANSWER_KEY_ENTRY_RE = /(?:q(?:uestion)?\s*)?(\d{1,3})\s*[\.\)\:\-]?\s*((?:[a-h]|true|false)(?:\s*(?:[,&\/+]|and)\s*(?:[a-h]|true|false))*)\b/gi;

function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\u00AD/g, '');
}

function splitLines(text) {
  return normalizeText(text).split('\n');
}

function isOptionLine(line) {
  return OPTION_RE.test(line) && line.trim().length > 1;
}

function isAnswerLine(line) {
  return ANSWER_RE.test(line.trim());
}

// Split lines that carry several options, e.g. "a) Venus  b) Mars  c) Jupiter".
function splitOptionsFromLine(text) {
  const matches = [...text.matchAll(INLINE_OPTION_RE)];
  if (matches.length < 2) return null;
  const options = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const key = matches[i][1].toLowerCase();
    const rawPart = text.slice(start, end);
    const starred = rawPart.includes('*');
    const optText = rawPart.replace(/\*/g, '').trim();
    if (optText) options.push({ key, text: optText, starred });
  }
  return options.length >= 2 ? { lead: text.slice(0, matches[0].index).trim(), options } : null;
}

// Parse trailing answer-key content ("1. b  2. c", "1-b 2-c", "1) a, c", "3. True").
function parseAnswerKeyEntries(text) {
  const map = new Map();
  const normalized = normalizeText(text).replace(/[()]/g, ' ').replace(/\n/g, ' ');
  ANSWER_KEY_ENTRY_RE.lastIndex = 0;
  let m = ANSWER_KEY_ENTRY_RE.exec(normalized);
  while (m) {
    const num = Number(m[1]);
    const value = m[2].toLowerCase().replace(/\s*and\s*/g, ',').replace(/\s*[,&\/+]\s*/g, ',').replace(/\s+/g, '');
    if (!map.has(num)) map.set(num, value);
    m = ANSWER_KEY_ENTRY_RE.exec(normalized);
  }
  return map;
}

function findTrailingKeyStart(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  let i = end - 1;
  const found = [];
  while (i >= 0) {
    const t = lines[i].trim();
    if (!t) { i -= 1; continue; }
    if (TRAILING_KEY_LINE_RE.test(t)) { found.push(i); i -= 1; } else break;
  }
  if (!found.length) return -1;
  const start = found[found.length - 1];
  const entries = parseAnswerKeyEntries(lines.slice(start).join('\n'));
  return entries.size >= 2 ? start : -1;
}

// Separate the questions from an answer-key section so keys are applied, not parsed as questions.
function splitAnswerKey(text) {
  const lines = splitLines(text);
  let headingIdx = -1;
  let inlineAfter = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isAnswerLine(lines[i])) continue;
    const m = lines[i].match(ANSWER_KEY_HEADING_RE);
    if (!m) continue;
    const rest = (m[1] || '').trim();
    if (rest === '' || /^\d/.test(rest) || /key|sheet|correct/i.test(lines[i])) {
      headingIdx = i;
      inlineAfter = m[1] || '';
      break;
    }
  }
  if (headingIdx !== -1) {
    const keyLines = [];
    if (inlineAfter.trim()) keyLines.push(inlineAfter);
    for (let i = headingIdx + 1; i < lines.length; i += 1) keyLines.push(lines[i]);
    return { questionText: lines.slice(0, headingIdx).join('\n'), answerKey: parseAnswerKeyEntries(keyLines.join('\n')) };
  }
  const start = findTrailingKeyStart(lines);
  if (start > 0) {
    return { questionText: lines.slice(0, start).join('\n'), answerKey: parseAnswerKeyEntries(lines.slice(start).join('\n')) };
  }
  return { questionText: text, answerKey: new Map() };
}

function extractAnswerKeys(raw) {
  // raw like: "b) Option text" or "b" or "True" or "a, c" or "(d)"
  const cleaned = raw.replace(/\(+/g, '').replace(/\)+/g, '').trim();
  const letters = [];
  const letterMatches = cleaned.match(/\b([a-h])\b/gi);
  const leading = cleaned.match(/^\s*([a-h])\s*[\.\):]?/i);
  if (leading) letters.push(leading[1].toLowerCase());
  if (letterMatches) letterMatches.forEach((l) => letters.push(l.toLowerCase()));
  const unique = [...new Set(letters.map((l) => l.toLowerCase()))];
  const tf = cleaned.match(/\b(true|false|yes|no)\b/i);
  if (tf && unique.length === 0) return [tf[1].toLowerCase()];
  if (unique.length) return unique;
  if (cleaned) return ['__text__:' + cleaned.toLowerCase()];
  return [];
}

function parseQuestionBlocks(text) {
  const lines = splitLines(text);
  const blocks = [];
  let current = null;
  let preamble = [];

  const pushCurrent = () => {
    if (current && (current.statement || current.options.length)) blocks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isAnswerLine(trimmed)) {
      if (!current) {
        // orphan answer — attach to last block if any
        if (blocks.length && !blocks[blocks.length - 1].rawAnswer) {
          blocks[blocks.length - 1].rawAnswer = trimmed.replace(ANSWER_RE, '$1').trim();
        }
        continue;
      }
      current.rawAnswer = trimmed.replace(ANSWER_RE, '$1').trim();
      continue;
    }

    const explMatch = trimmed.match(EXPLANATION_RE);
    if (explMatch && current) {
      current.explanation = explMatch[1].trim();
      continue;
    }

    const qMatch = trimmed.match(QUESTION_RE);
    if (qMatch && !isOptionLine(trimmed)) {
      // A new numbered line always starts a new question. Options may share the line.
      pushCurrent();
      const raw = qMatch[2].trim();
      const split = splitOptionsFromLine(raw);
      current = {
        questionNumber: Number(qMatch[1]),
        statement: split ? split.lead : raw,
        options: split ? split.options : [],
        rawAnswer: '',
        explanation: '',
        sourceOrder: blocks.length,
      };
      continue;
    }

    if (SECTION_RE.test(trimmed)) {
      // standalone section heading; ignore
      continue;
    }

    if (isOptionLine(trimmed)) {
      if (!current) {
        // Option-looking line outside a question is a section heading (e.g. "A. General Science")
        continue;
      }
      const split = splitOptionsFromLine(trimmed);
      if (split) {
        current.options.push(...split.options);
        continue;
      }
      const m = trimmed.match(OPTION_RE);
      const key = m[1].toLowerCase();
      const starred = trimmed.includes('*');
      const optText = m[2].replace(/\*/g, '').trim();
      current.options.push({ key, text: optText, starred });
      continue;
    }

    if (!current) {
      if (trimmed) preamble.push(trimmed);
      continue;
    }

    // continuation of statement (multi-paragraph questions)
    if (current.options.length === 0) {
      current.statement = current.statement ? `${current.statement} ${trimmed}`.trim() : trimmed;
    } else {
      // continuation of last option text
      const last = current.options[current.options.length - 1];
      last.text = `${last.text} ${trimmed}`.trim();
    }
  }
  pushCurrent();
  return { blocks, orphanPreamble: preamble.join(' ').trim() };
}

function resolveAnswer(block) {
  const { options, rawAnswer } = block;
  const issues = [];
  let correctAnswers = [];
  let type = 'mcq';

  const hasTF = options.length === 2 && options.every((o) => /^(true|false)$/i.test(o.text));
  const bareTF = !options.length && /^(true|false)$/i.test(String(rawAnswer).replace(/^[a-hA-H][\.)\:]?\s*/i, '').trim());
  const isFillLike = /_{3,}|fill\s*in\s*the\s*blank/i.test(block.statement);

  if (bareTF) {
    const val = String(rawAnswer).trim().toLowerCase();
    return { correctAnswers: [val === 'true' ? 'true' : 'false'], issues: [], type: 'tf', autoOptions: true };
  }

  if (!rawAnswer || !rawAnswer.trim()) {
    issues.push('missing_answer');
    return { correctAnswers: [], issues, type: hasTF ? 'tf' : isFillLike ? 'fill' : 'mcq' };
  }

  const keys = extractAnswerKeys(rawAnswer);
  const textKey = keys.find((k) => k.startsWith('__text__:'));
  const letterKeys = keys.filter((k) => !k.startsWith('__text__:'));

  if (hasTF) {
    type = 'tf';
    const raw = String(rawAnswer);
    const tfText = (raw.match(/\b(true|false|yes|no)\b/i) || [])[1];
    const leading = raw.match(/^\s*([a-hA-H])\s*[\.\)\:]?/);
    const labelKey = leading ? leading[1].toLowerCase() : null;
    const labelOpt = labelKey ? options.find((o) => o.key === labelKey) : null;

    if (tfText) {
      const val = /^(true|yes)$/i.test(tfText) ? 'true' : 'false';
      if (labelKey && !labelOpt) {
        issues.push('answer_letter_not_in_options');
        correctAnswers = [val];
      } else if (labelOpt) {
        const labelVal = /^true$/i.test(labelOpt.text) ? 'true' : /^false$/i.test(labelOpt.text) ? 'false' : null;
        if (labelVal && labelVal !== val) {
          // The option label and the answer text disagree (e.g. "B) True").
          // Keep both; do not silently choose either value.
          issues.push('answer_letter_text_conflict');
          correctAnswers = [];
        } else {
          correctAnswers = [val];
        }
      } else {
        correctAnswers = [val];
      }
    } else if (labelOpt) {
      if (/^true$/i.test(labelOpt.text)) correctAnswers = ['true'];
      else if (/^false$/i.test(labelOpt.text)) correctAnswers = ['false'];
      else issues.push('answer_not_matching_options');
    } else {
      issues.push('answer_not_matching_options');
    }
    return { correctAnswers, issues, type };
  }

  if (letterKeys.length) {
    const validKeys = new Set(options.map((o) => o.key));
    const valid = letterKeys.filter((k) => validKeys.has(k));
    const invalid = letterKeys.filter((k) => !validKeys.has(k));
    if (!valid.length) {
      issues.push('answer_letter_not_in_options');
    } else {
      if (invalid.length) issues.push('answer_letter_not_in_options');
      correctAnswers = valid;
      if (letterKeys.length > 1) type = 'msq';
      // consistency check: answer text (if any) vs option text
      const textPart = rawAnswer.replace(/^[a-hA-H][\.\)\:]?\s*/i, '').trim();
      if (textPart && textPart.length > 2) {
        const matched = options.find(
          (o) => o.text.toLowerCase().replace(/\s+/g, ' ').trim() === textPart.toLowerCase().replace(/\s+/g, ' ').trim()
        );
        if (!matched) issues.push('answer_text_mismatch');
        else if (valid.length === 1 && matched.key !== valid[0]) {
          issues.push('answer_letter_text_conflict');
          correctAnswers = [matched.key];
        }
      }
    }
  }

  if (!correctAnswers.length && textKey) {
    const answerText = textKey.replace('__text__:', '');
    const matched = options.filter((o) => o.text.toLowerCase().trim() === answerText);
    if (matched.length) {
      correctAnswers = matched.map((o) => o.key);
      if (correctAnswers.length > 1) type = 'msq';
    } else if (isFillLike) {
      type = 'fill';
      correctAnswers = [rawAnswer.trim()];
    } else {
      issues.push('answer_not_matching_options');
    }
  }

  if (!options.length && !isFillLike) issues.push('no_options');
  if (options.length && options.length < 2 && !isFillLike) issues.push('too_few_options');

  if (correctAnswers.length > 1) type = type === 'tf' ? 'tf' : 'msq';
  return { correctAnswers, issues, type };
}

function parseQuestions(rawText, options = {}) {
  const { questionText, answerKey } = splitAnswerKey(rawText);
  const { blocks, orphanPreamble } = parseQuestionBlocks(questionText);
  const seen = new Map();
  const questions = [];
  let missingAnswer = 0;
  let needsReview = 0;
  let duplicates = 0;

  blocks.forEach((block, idx) => {
    const statement = block.statement.trim();
    if (!statement && !block.options.length) return;

    if (!block.rawAnswer && block.questionNumber != null && answerKey.has(block.questionNumber)) {
      block.rawAnswer = answerKey.get(block.questionNumber);
    }
    if (!block.rawAnswer) {
      const starredKeys = block.options.filter((o) => o.starred).map((o) => o.key);
      if (starredKeys.length) block.rawAnswer = starredKeys.join(',');
    }

    const { correctAnswers, issues: answerIssues, type, autoOptions } = resolveAnswer(block);
    if (autoOptions && !block.options.length) {
      block.options = [{ key: 'true', text: 'True' }, { key: 'false', text: 'False' }];
    }
    const issues = [...answerIssues];

    if (!statement) issues.push('empty_statement');

    const hash = statement.toLowerCase().replace(/\s+/g, ' ').trim();
    let duplicateOfIndex = null;
    if (seen.has(hash)) {
      duplicates += 1;
      duplicateOfIndex = seen.get(hash);
      issues.push('duplicate');
    } else {
      seen.set(hash, idx);
    }

    if (correctAnswers.length === 0) missingAnswer += 1;
    if (issues.length) needsReview += 1;

    // validate option keys uniqueness
    const keys = block.options.map((o) => o.key);
    if (new Set(keys).size !== keys.length) issues.push('duplicate_option_keys');

    questions.push({
      type: options.forceType || type,
      statement,
      options: block.options,
      correctAnswers,
      explanation: block.explanation || '',
      marks: 1,
      issues: [...new Set(issues)],
      duplicateOfIndex,
      sourceOrder: block.sourceOrder,
    });
  });

  const valid = questions.filter((q) => q.issues.length === 0).length;

  if (!questions.length && orphanPreamble) {
    // nothing parseable
    return {
      questions: [],
      stats: { total: 0, valid: 0, needsReview: 0, missingAnswer: 0, duplicates: 0 },
      warning: 'No questions could be detected. Check that questions are numbered (e.g. "1. ...") and options are labelled (a), b), ...).',
    };
  }

  return {
    questions,
    stats: {
      total: questions.length,
      valid,
      needsReview,
      missingAnswer,
      duplicates,
    },
    warning: questions.length === 0 ? 'No questions could be detected in the document.' : '',
  };
}

module.exports = { parseQuestions, extractAnswerKeys };
