/**
 * Утилиты для подсветки терминов в тексте
 */

import React from 'react';

/**
 * Подсвечивает термин в тексте, оборачивая его в <mark>
 * 
 * @param text Исходный текст
 * @param term Термин для подсветки (может быть null)
 * @returns JSX с подсвеченными терминами
 */
export function highlightTerm(
  text: string,
  term: string | null,
): React.ReactNode {
  if (!term || !text) {
    return text;
  }
  
  // Экранируем специальные символы для regex
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  // Создаем regex для поиска термина (case-insensitive, word boundaries)
  const regex = new RegExp(`(${escapedTerm})`, 'gi');
  
  // Разбиваем текст на части
  const parts = text.split(regex);
  
  // Оборачиваем найденные термины в <mark>
  return parts.map((part, idx) => {
    // Проверяем, является ли часть термином (case-insensitive)
    if (part.toLowerCase() === term.toLowerCase()) {
      return (
        <mark
          key={idx}
          className="bg-yellow-200 px-1 rounded font-medium"
          style={{ backgroundColor: '#fef08a' }}
        >
          {part}
        </mark>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

/**
 * Подсвечивает несколько терминов одновременно
 * 
 * @param text Исходный текст
 * @param terms Массив терминов для подсветки
 * @returns JSX с подсвеченными терминами
 */
export function highlightTerms(
  text: string,
  terms: string[],
): React.ReactNode {
  if (!terms.length || !text) {
    return text;
  }
  
  // Создаем regex для всех терминов
  const escapedTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  
  const parts = text.split(regex);
  
  return parts.map((part, idx) => {
    const isTerm = terms.some(t => part.toLowerCase() === t.toLowerCase());
    if (isTerm) {
      return (
        <mark
          key={idx}
          className="bg-yellow-200 px-1 rounded font-medium"
          style={{ backgroundColor: '#fef08a' }}
        >
          {part}
        </mark>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

/**
 * Проверяет, содержит ли текст термин (case-insensitive)
 */
export function containsTerm(text: string, term: string | null): boolean {
  if (!term || !text) return false;
  return text.toLowerCase().includes(term.toLowerCase());
}
