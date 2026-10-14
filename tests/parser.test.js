const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseQuestions } = require('../utils/questionParser');

const SAMPLE = `
A. General Science

1. Which planet is known as the Red Planet?
a) Venus
b) Mars
c) Jupiter
d) Saturn
Answer: b) Mars
Explanation: Mars appears red due to iron oxide.

2. Water boils at what temperature at sea level?
(a) 100 degrees Celsius
(b) 90 degrees Celsius
(c) 80 degrees Celsius
(d) 70 degrees Celsius
Ans: a

3. The sun rises in the
a) North
b) South
c) East
d) West
Answer: c

4. The capital of France is Paris.
Answer: True

5. Chemical symbol for gold is ____ .
a) Ag
b) Au
c) Fe
d) Cu
Answer: b

6. Select all prime numbers.
a) 2
b) 4
c) 7
d) 9
Answer: a, c

7. This question has no answer provided.
a) One
b) Two

8. What is 2 + 2?
Answer: 4
`;

describe('Question parser', () => {
  test('detects numbered questions and labelled options', () => {
    const { questions, stats } = parseQuestions(SAMPLE);
    assert.equal(stats.total, 8, `expected 8, got ${stats.total}`);
    assert.equal(questions[0].options.length, 4);
    assert.equal(questions[0].options[0].key, 'a');
    assert.equal(questions[0].statement, 'Which planet is known as the Red Planet?');
  });

  test('extracts explicit answers with option text', () => {
    const { questions } = parseQuestions(SAMPLE);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
    assert.equal(questions[0].issues.length, 0);
  });

  test('extracts letter-only answers', () => {
    const { questions } = parseQuestions(SAMPLE);
    assert.deepEqual(questions[1].correctAnswers, ['a']);
    assert.deepEqual(questions[2].correctAnswers, ['c']);
  });

  test('parses true/false', () => {
    const { questions } = parseQuestions(SAMPLE);
    const tf = questions.find((q) => q.type === 'tf');
    assert.ok(tf, 'tf question found');
    assert.deepEqual(tf.correctAnswers, ['true']);
  });

  test('parses fill-in-the-blank with answer choices', () => {
    const { questions } = parseQuestions(SAMPLE);
    const fill = questions.find((q) => /_{3,}/.test(q.statement));
    assert.ok(fill, 'fill question found');
    assert.deepEqual(fill.correctAnswers, ['b']);
  });

  test('detects multiple-select from multiple answer letters', () => {
    const { questions } = parseQuestions(SAMPLE);
    const msq = questions.find((q) => q.type === 'msq');
    assert.ok(msq, 'msq found');
    assert.deepEqual([...msq.correctAnswers].sort(), ['a', 'c']);
  });

  test('flags missing answers instead of inventing them', () => {
    const { questions, stats } = parseQuestions(SAMPLE);
    const missing = questions.find((q) => q.issues.includes('missing_answer'));
    assert.ok(missing, 'missing answer flagged');
    assert.equal(missing.correctAnswers.length, 0);
    assert.ok(stats.missingAnswer >= 1);
  });

  test('flag answer letter not present in options', () => {
    const text = `1. Broken question?
a) One
b) Two
Answer: e) Nope`;
    const { questions } = parseQuestions(text);
    assert.ok(questions[0].issues.includes('answer_letter_not_in_options'));
    assert.equal(questions[0].correctAnswers.length, 0);
  });

  test('flag answer text mismatch with letter', () => {
    const text = `1. Capital of India?
a) Mumbai
b) New Delhi
Answer: a) New Delhi`;
    const { questions } = parseQuestions(text);
    // letter says a, text says New Delhi (= b) — conflict must be flagged and resolved to text match
    assert.ok(
      questions[0].issues.includes('answer_letter_text_conflict') || questions[0].issues.includes('answer_text_mismatch'),
      JSON.stringify(questions[0].issues)
    );
    assert.deepEqual(questions[0].correctAnswers, ['b']);
  });

  test('handles multi-paragraph questions', () => {
    const text = `1. This is a long question that spans
multiple lines and paragraphs before the options appear.

a) First
b) Second
Answer: a`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 1);
    assert.match(questions[0].statement, /multiple lines/);
    assert.deepEqual(questions[0].correctAnswers, ['a']);
  });

  test('detects duplicates within the document', () => {
    const text = `1. Same question?
a) X
b) Y
Answer: a
2. Same question?
a) X
b) Y
Answer: a`;
    const { stats } = parseQuestions(text);
    assert.equal(stats.duplicates, 1);
  });

  test('returns warning when nothing parseable', () => {
    const { questions, warning } = parseQuestions('Just some random paragraph without numbers.');
    assert.equal(questions.length, 0);
    assert.ok(warning);
  });

  test('applies an answer key section to questions', () => {
    const text = `1. Which planet is known as the Red Planet?
a) Venus
b) Mars
c) Jupiter
d) Saturn

2. Water boils at what temperature?
a) 100
b) 90
c) 80
d) 70

3. Select all prime numbers.
a) 2
b) 4
c) 7
d) 9

Answer Key
1. b
2. a
3. a, c`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 3);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
    assert.equal(questions[0].issues.length, 0);
    assert.deepEqual(questions[1].correctAnswers, ['a']);
    assert.equal(questions[2].type, 'msq');
    assert.deepEqual([...questions[2].correctAnswers].sort(), ['a', 'c']);
  });

  test('applies a trailing answer key without a heading', () => {
    const text = `1. Capital of India?
a) Mumbai
b) New Delhi
2. Capital of Japan?
a) Beijing
b) Tokyo
1-b 2-b`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
    assert.deepEqual(questions[1].correctAnswers, ['b']);
  });

  test('extracts answers written with a period separator (Ans. b)', () => {
    const text = `1. Capital of France?
a) London
b) Paris
Ans. b`;
    const { questions } = parseQuestions(text);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
    assert.equal(questions[0].issues.length, 0);
  });

  test('detects the correct option marked with an asterisk', () => {
    const text = `1. Which planet is known as the Red Planet?
a) Venus
* b) Mars
c) Jupiter
d) Saturn`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
    assert.equal(questions[0].issues.length, 0);
    assert.equal(questions[0].options[1].text, 'Mars');
  });

  test('splits options written on a single line', () => {
    const text = `1. Which planet is known as the Red Planet? a) Venus b) Mars c) Jupiter d) Saturn
Answer: b`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].statement, 'Which planet is known as the Red Planet?');
    assert.deepEqual(questions[0].options.map((o) => o.key), ['a', 'b', 'c', 'd']);
    assert.deepEqual(questions[0].correctAnswers, ['b']);
  });

  test('detects a True/False label/text contradiction without choosing a value', () => {
    const text = `1. HTML forms collect user input.
A. True
B. False
Source answer: B) True`;
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].type, 'tf');
    assert.deepEqual(questions[0].options.map((o) => o.text), ['True', 'False']);
    assert.ok(questions[0].issues.includes('answer_letter_text_conflict'));
    assert.equal(questions[0].correctAnswers.length, 0, 'no value is silently chosen');
  });

  test('parses a consistent True/False answer with a label', () => {
    const text = `1. The sky is blue.
A. True
B. False
Answer: A) True`;
    const { questions } = parseQuestions(text);
    assert.equal(questions[0].type, 'tf');
    assert.deepEqual(questions[0].correctAnswers, ['true']);
    assert.equal(questions[0].issues.length, 0);
  });

  test('TXT extraction returns parseable raw text', async () => {
    const tmp = path.join(os.tmpdir(), `rcld_test_${Date.now()}.txt`);
    fs.writeFileSync(tmp, SAMPLE);
    const { extractText } = require('../utils/extractText');
    const text = await extractText(tmp);
    assert.match(text, /Red Planet/);
    const { questions } = parseQuestions(text);
    assert.equal(questions.length, 8);
    fs.unlinkSync(tmp);
  });

  test('unsupported file types are rejected', async () => {
    const tmp = path.join(os.tmpdir(), `rcld_test_${Date.now()}.xyz`);
    fs.writeFileSync(tmp, 'not a document');
    const { extractText } = require('../utils/extractText');
    await assert.rejects(() => extractText(tmp), /Unsupported file type/);
    fs.unlinkSync(tmp);
  });
});
