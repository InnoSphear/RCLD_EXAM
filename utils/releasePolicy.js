// Central exam result release policy — single source of truth.
function isResultReleased(exam, attempt = null) {
  if (!exam) return false;
  if (exam.resultsReleased) return true;
  if (exam.resultRelease === 'immediate') return true;
  if (exam.resultRelease === 'after_deadline') {
    const now = new Date();
    return now > exam.endsAt && (!attempt || attempt.status !== 'in_progress');
  }
  return false; // manual
}

module.exports = { isResultReleased };
