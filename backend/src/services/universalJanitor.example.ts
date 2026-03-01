/**
 * Примеры использования UniversalJanitor
 */

import { UniversalJanitor } from './universalJanitor';
import type { JanitorReport } from './universalJanitor';

/**
 * Пример 1: Базовый аудит документа
 */
export async function exampleBasicAudit() {
  const janitor = new UniversalJanitor();

  const report = await janitor.auditSegments('document-id', {
    autoFix: true, // Автоматически исправлять мелкие ошибки
    strictMode: false,
    dryRun: false, // Сохранять изменения в БД
  });

  console.log('=== Janitor Report ===');
  console.log(`Document: ${report.documentName}`);
  console.log(`Direction: ${report.direction}`);
  console.log(`Total segments: ${report.statistics.totalSegments}`);
  console.log(`Validated: ${report.statistics.validated}`);
  console.log(`Auto-fixed: ${report.statistics.autoFixed}`);
  console.log(`Requires review: ${report.statistics.requiresReview}`);
  console.log(`Total errors: ${report.statistics.totalErrors}`);

  // Сегменты, требующие проверки
  const requiresReview = report.segments.filter(s => s.status === 'REQUIRES_REVIEW');
  console.log(`\nSegments requiring review: ${requiresReview.length}`);
  
  for (const segment of requiresReview.slice(0, 5)) {
    console.log(`\nSegment ${segment.segmentIndex}:`);
    console.log(`  Comment: ${segment.janitorComment}`);
    console.log(`  Errors: ${segment.errors.length}`);
    for (const error of segment.errors) {
      console.log(`    - ${error.message}`);
    }
  }

  return report;
}

/**
 * Пример 2: Dry-run режим (без сохранения)
 */
export async function exampleDryRun() {
  const janitor = new UniversalJanitor();

  const report = await janitor.auditSegments('document-id', {
    autoFix: true,
    strictMode: true, // Строгий режим
    dryRun: true, // Не сохранять изменения
  });

  // Анализируем результаты перед применением
  console.log('Would fix:', report.statistics.autoFixed);
  console.log('Would flag for review:', report.statistics.requiresReview);

  return report;
}

/**
 * Пример 3: Анализ конкретных типов ошибок
 */
export async function exampleErrorAnalysis() {
  const janitor = new UniversalJanitor();

  const report = await janitor.auditSegments('document-id', {
    autoFix: false, // Не исправлять автоматически, чтобы увидеть все ошибки
  });

  // Анализ по типам ошибок
  console.log('=== Error Analysis ===');
  console.log('Missed terms:', report.statistics.errorsByType.MISSED_TERM);
  console.log('Wrong terms:', report.statistics.errorsByType.WRONG_TERM);
  console.log('Script mixing:', report.statistics.errorsByType.SCRIPT_MIXING);
  console.log('Constraint violations:', report.statistics.errorsByType.CONSTRAINT_VIOLATION);

  // Находим сегменты с пропущенными терминами
  const missedTermSegments = report.segments.filter(s =>
    s.errors.some(e => e.type === 'MISSED_TERM')
  );

  console.log(`\nSegments with missed terms: ${missedTermSegments.length}`);
  for (const segment of missedTermSegments.slice(0, 3)) {
    const missedTerms = segment.errors
      .filter(e => e.type === 'MISSED_TERM')
      .map(e => e.term)
      .join(', ');
    console.log(`  Segment ${segment.segmentIndex}: ${missedTerms}`);
  }

  return report;
}

/**
 * Пример 4: Использование с синтезированной DNA
 */
export async function exampleWithSynthesizedDna() {
  // Предполагаем, что DNA уже синтезирована и сохранена в БД
  const janitor = new UniversalJanitor();

  const report = await janitor.auditSegments('document-id', {
    autoFix: true,
    strictMode: false,
  });

  console.log('=== DNA Usage ===');
  console.log(`Total DNA terms: ${report.dnaUsed.totalTerms}`);
  console.log(`Terms checked: ${report.dnaUsed.termsChecked}`);
  console.log(`Validation rules: ${report.dnaUsed.validationRules}`);

  return report;
}
