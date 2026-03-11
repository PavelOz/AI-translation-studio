/**
 * Modular prompt system for the Universal DNA Architect.
 * Ensures consistent, direction-aware Document DNA generation for RU→EN and EN→RU.
 */

export type TranslationDirection = 'ru-en' | 'en-ru' | 'other';

/**
 * Detect translation direction from document locales for template selection.
 * Used by generateDocumentDna and refineDocumentDna to pick the right rules.
 */
export function getTranslationDirection(
  sourceLocale: string,
  targetLocale: string,
): TranslationDirection {
  const src = (sourceLocale || 'en').trim().toLowerCase().split(/[-_]/)[0];
  const tgt = (targetLocale || 'en').trim().toLowerCase().split(/[-_]/)[0];
  if ((src === 'ru' || src === 'rus') && (tgt === 'en' || tgt === 'eng')) return 'ru-en';
  if ((src === 'en' || src === 'eng') && (tgt === 'ru' || tgt === 'rus')) return 'en-ru';
  return 'other';
}

/** Base role and task (direction-agnostic). */
const BASE_ROLE = `You act as the "Universal DNA Architect": Expert Technical Analyst for KEGOC, specializing in International Power Systems (UES of Kazakhstan) and International Finance Standards (ADB, IFC, WB).
Task: Scan the document and generate a Document DNA (JSON) that maps Source (Key) to Target (Value).

DIRECTION LOGIC (strict):
- If RU → EN: Key = Russian, Value = English.
- If EN → RU: Key = English, Value = Russian.`;

/** Institutional memory: ADB/IFC terminology for reports and safeguards. */
const INSTITUTIONAL_ADB_IFC = `
INSTITUTIONAL MEMORY (ADB / IFC / WB reports and safeguards):
- Use standard terminology: Involuntary Resettlement → Вынужденное переселение (EN→RU); Grievance Redress Mechanism → Механизм рассмотрения жалоб; Stakeholder Engagement → Взаимодействие с заинтересованными сторонами.
- "Requires a waiver" → "Требуется вейвер" or "Требуется освобождение от выполнения условия" (when target is Russian).
- Official acronyms: ADB → АБР, IFC → МФК, MERK → МЭ РК, NDC SO → НДЦ СО (use in entityGroups/namingConventions where relevant).`;

/** Institutional memory: UES of Kazakhstan / KEGOC technical instructions. */
const INSTITUTIONAL_UES_KZ = `
INSTITUTIONAL MEMORY (UES of Kazakhstan / KEGOC technical instructions):
- Prefer IEC/IEEE and regional standard abbreviations for power systems (VT, CT, SA, BTB, CB).
- Technical indices: Руст, Рраб, Ррасп (or P_inst, P_work, P_avail) → always Latin shortForm: Pinst, Pwork, Pavail, regardless of direction.
- For RU→EN: сальдо-переток → Net tie-line flow; совмещенный максимум → Coincident Peak; extract ПУЛ РЭМ, САОН, АРЧМ from document and add to abbreviationLogic with target-language definition.`;

/** Ideal DNA structure (few-shot); shared across directions. */
export const ULTIMATE_DNA_TEMPLATE = `{
  "technicalSchema": {
    "market": { "description": "Market-related entities and terms" },
    "dispatch": { "description": "Dispatch and operational terms" },
    "protection": { "description": "Protection and relay terms" },
    "social": { "description": "Social impact and stakeholder terms" },
    "environmental": { "description": "Environmental impact and mitigation terms" }
  },
  "namingConventions": {
    "dateNotation": "Dates in DD Month YYYY format (e.g. 30 June 2026).",
    "phaseLetters": "Phases: only Latin letters (A, B, C). Cyrillic А, В, С must be converted to Latin.",
    "definitionsFormatting": "In Definitions section STRICTLY use format: 'Latin label – Full form' (e.g. Pinst – installed electric capacity). Label must not disappear.",
    "abbreviationRedundancy": "After first mention in the document use ONLY abbreviations (e.g. NDC SO, ERS, COTC, MERK, UPS). Do NOT repeat full form in every clause.",
    "priorityLevels": "Priority levels: High, Medium, Low (use nominative case in target)."
  },
  "abbreviationLogic": {
    "сальдо-переток": { "longForm": "Net tie-line flow", "shortForm": "Net tie-line flow" },
    "анцапф": { "longForm": "Tap position", "shortForm": "Tap position" },
    "усредненный": { "longForm": "Coincident", "shortForm": "Coincident" },
    "наброс мощности": { "longForm": "Power swing", "shortForm": "Power swing" },
    "Руст": { "longForm": "installed electric capacity", "shortForm": "Pinst" },
    "Рраб": { "longForm": "operating power", "shortForm": "Pwork" },
    "Ррасп": { "longForm": "available power", "shortForm": "Pavail" }
  },
  "entityGroups": {}
}`;

/** Syntactic few-shot: structure-based extraction examples (improves term boundary detection per research). */
const SYNTACTIC_FEW_SHOT = `
SYNTACTIC FEW-SHOT (use structure, not topic, to detect term boundaries):

Example A – Section number + noun phrase (RU): "11.02.05. Подвеска провода, на 35 км"
→ Extract leading "11.02.05." as section numbering convention; extract "Подвеска провода" as one term → abbreviationLogic: { "Подвеска провода": { "longForm": "Conductor stringing", "shortForm": "Conductor stringing" } }. Do not split "Подвеска провода"; do not treat "на 35 км" as the main term.

Example B – Section number + noun phrase (EN): "3.2.1. Busbar section alignment, at 110 kV"
→ Section "3.2.1." as naming convention; "Busbar section alignment" as one term. Keep "at 110 kV" as context, not a separate term.

Rule: When you see [digits.digits.digits.] followed by [Noun phrase], [modifier], treat the noun phrase as a single term and the leading digits as a section identifier. Preserve exact boundaries; do not merge unrelated words into one term or split multi-word technical phrases.`;

/** Shared categorization: three layers (Technical Indices, Fixed Enums, Hybrid Abbreviations). */
const CATEGORIZATION_INTRO = `
UNIVERSAL DNA ARCHITECT – CATEGORIZATION (apply automatically):

1) Technical Indices (Physics layer): Symbols like P_inst, P_work, R_ust, P_avail (or Руст, Рраб, Ррасп). ALWAYS keep Latin in both longForm and shortForm (Pinst, Pwork, Pavail) regardless of direction. Example: "Руст": { "longForm": "installed electric capacity", "shortForm": "Pinst" }.

2) Fixed Enums (Status layer): Recurring labels (Priority: High, Medium, Low; Status: Closed, Partial compliance, Pending). Place in technicalSchema or namingConventions. Use ONLY nominative case (именительный падеж) in the target language. Example (EN→RU): "Pending": "В ожидании", "High": "Высокий".

3) Hybrid Abbreviations: See direction-specific rules below.`;

/** Direction-specific prompt blocks. */
const DIRECTIONAL_TEMPLATES: Record<
  TranslationDirection,
  {
    directionLabel: string;
    categorizationExtra: string;
    domainSpecificBlock: string;
    phaseLettersRule: string;
    abbreviationLogicHint: string;
  }
> = {
  'ru-en': {
    directionLabel: 'RU → EN',
    categorizationExtra: '',
    domainSpecificBlock: `
SUBSTATION TOPOLOGY (when the document describes switchgear, substations, or power equipment):
- РУ / Switchgear → bays (not "cells"). Ячейка / ЯЧ → Bay (never "Cell" in substation context).
- Шина / СШ → Busbar. Секция шин → Busbar section.
- ШСВ → Bus Tie Breaker (BTB). ОВ → Bypass Breaker. В / Выключатель → Circuit Breaker (CB).
- ТН → Voltage Transformer (VT). ТТ → Current Transformer (CT). ОПН → Surge Arrester (SA).
- Use IEC/IEEE standard abbreviations in abbreviationLogic (VT, CT, SA, BTB, CB, etc.).`,
    phaseLettersRule: ` When the source uses Cyrillic phase letters, include: "phaseLetters": "Phases indicated by Cyrillic letters (А, В, С, etc.) must ALWAYS be converted to Latin (A, B, C) in the target text."`,
    abbreviationLogicHint: 'longForm and shortForm in English; technical indices always Latin (Pinst, Pwork, Pavail).',
  },
  'en-ru': {
    directionLabel: 'EN → RU',
    categorizationExtra: `
HYBRID ABBREVIATIONS (EN → RU): For project terms like ESMP, IESE, SPS, ESAP use Russian abbreviation followed by English in brackets for auditor cross-reference. Example: "ESMP": { "longForm": "План управления окружающей и социальной средой", "shortForm": "ПУОСС (ESMP)" }.`,
    domainSpecificBlock: `
EN→RU SPECIFIC: Put fixed status enums in technicalSchema/namingConventions with Russian in nominative case (В ожидании, Закрыто, Частичное соответствие, Высокий, Средний, Низкий). Institutional: ADB→АБР, IFC→МФК, "Requires a waiver"→"Требуется вейвер" or "Требуется освобождение от выполнения условия".`,
    phaseLettersRule: ' Document phase names, type labels, symbols, and units in both source and target where relevant.',
    abbreviationLogicHint: 'longForm in Russian; shortForm = "ПУОСС (ESMP)" style for international terms; technical indices still Latin (Pinst, Pwork, Pavail).',
  },
  other: {
    directionLabel: 'Other',
    categorizationExtra: '',
    domainSpecificBlock: ' Use standard terminology for the target language; technicalSchema and namingConventions in target.',
    phaseLettersRule: ' Document phase names, type labels, symbols, and units where relevant.',
    abbreviationLogicHint: 'longForm and shortForm in target language; technical indices in Latin when applicable.',
  },
};

export interface BuildDnaGenerateParams {
  sourceLocale: string;
  targetLocale: string;
  sourceLangHint: string;
  targetLangHint: string;
  profile?: { name: string; expertRole: string; instructions: string; terminologyJSON: unknown } | null;
  documentName: string;
  textToAnalyze: string;
}

/**
 * Build full system prompt for Document DNA generation (generateDocumentDna).
 * Uses direction detection to inject ru-en or en-ru specific rules.
 */
export function buildDnaGenerateSystemPrompt(params: {
  sourceLocale: string;
  targetLocale: string;
  sourceLangHint: string;
  targetLangHint: string;
  profile?: { name: string; expertRole: string; instructions: string; terminologyJSON: unknown } | null;
  /** If set, activates institutional blocks: 'ADB' → must use ADB/IFC terms; 'KEGOC' → must use UES Kazakhstan dispatch terms. If omitted, derived from profile?.name. */
  profileContext?: string;
}): string {
  const { sourceLocale, targetLocale, sourceLangHint, targetLangHint, profile, profileContext } = params;
  const direction = getTranslationDirection(sourceLocale, targetLocale);
  const t = DIRECTIONAL_TEMPLATES[direction];

  const ctx = (profileContext ?? profile?.name ?? '').toUpperCase();
  const hasADB = ctx.includes('ADB');
  const hasKEGOC = ctx.includes('KEGOC');

  const institutionalPriorityBlock = `
PRIORITY: Institutional Profile terms ALWAYS override general LLM knowledge.
${hasADB ? `Profile context ADB: You MUST use terminology from the INSTITUTIONAL (ADB/IFC/WB) block below (e.g. Grievance Redress Mechanism → Механизм рассмотрения жалоб, Involuntary Resettlement → Вынужденное переселение, Stakeholder Engagement → Взаимодействие с заинтересованными сторонами).` : ''}
${hasKEGOC ? `Profile context KEGOC: You MUST apply the INSTITUTIONAL (UES Kazakhstan/KEGOC) block for dispatch and power terminology (сальдо-переток → Net tie-line flow, ПУЛ РЭМ, САОН, АРЧМ, and related terms from that block).` : ''}
`;

  const expertRoleLine = profile
    ? `You are a ${profile.expertRole}. Your task is to analyze the provided document sample and produce a structured "Document DNA" JSON that will be used as a PROJECT KNOWLEDGE BASE for translation. Identify technical terms and provide translations from ${sourceLocale} (${sourceLangHint}) to ${targetLocale} (${targetLangHint}).`
    : `You are a Lead technical engineer with expertise in international standards and terminology (KEGOC, UES of Kazakhstan, ADB, IFC, WB). Your task is to analyze the provided document sample and produce a structured "Document DNA" JSON that will be used as a PROJECT KNOWLEDGE BASE for translation. Identify technical terms and provide translations from ${sourceLocale} (${sourceLangHint}) to ${targetLocale} (${targetLangHint}).`;

  const profileTerminologyBlock =
    profile?.terminologyJSON != null
      ? `\n\nBASE TERMINOLOGY (from profile "${profile.name}" – merge with document findings):\n${typeof profile.terminologyJSON === 'string' ? profile.terminologyJSON : JSON.stringify(profile.terminologyJSON, null, 2)}`
      : '';

  const profileInstructionsBlock =
    profile?.instructions?.trim()
      ? `\n\nPRIORITY RULES (from profile – apply these first):\n${profile.instructions}`
      : '';

  const defaultKnowledgeBlock = `

DEFAULT KNOWLEDGE (combine with profile and document sample when applicable):
${institutionalPriorityBlock}
Direction: ${t.directionLabel}
${t.domainSpecificBlock}
${CATEGORIZATION_INTRO}
${t.categorizationExtra}

4) Output structure: abbreviationLogic – every entry MUST be an object with { longForm, shortForm }; no plain strings. shortForm must NOT contain the source-language key (e.g. do not put "ЕЭС" inside the value when key is "ЕЭС"); use only target-language abbreviation to avoid recursive replacement. technicalSchema – groups: Market, Dispatch, Protection, Social, Environmental. namingConventions – include dateNotation, phaseLetters; for institutional docs add definitionsFormatting and abbreviationRedundancy (after first mention use ONLY abbreviations; in Definitions use "Latin label – Full form").
${INSTITUTIONAL_ADB_IFC}
${INSTITUTIONAL_UES_KZ}

=== IDEAL DNA (few-shot reference) ===
Merge Golden DNA (verified translations) with Revision hierarchy. Use this structure as the standard.

Ideal DNA (structure + verified terms):
${ULTIMATE_DNA_TEMPLATE}
${SYNTACTIC_FEW_SHOT}

INFERENCE RULE: If you see ПУЛ РЭМ, САОН or АРЧМ in the document text, extract their definitions from the document and add them to abbreviationLogic/namingConventions, translating according to the same standard.

FORCE DEFINITIONS: For abbreviations like ПУЛ РЭМ, САОН, АРЧМ — find the exact definition in the text and include it in abbreviationLogic (value = target-language definition). Do not leave technicalSchema categories (market, dispatch, protection, social, environmental) empty.

TERMINOLOGY ENFORCEMENT: Prefer "Net tie-line flow" for сальдо-переток and "Coincident Peak" for совмещенный максимум when direction is RU→EN.

BILINGUAL REQUIREMENT: Keys in abbreviationLogic/namingConventions must be in the SOURCE language; values must be in the TARGET language. ${t.abbreviationLogicHint}

Extract and return ONLY a valid JSON object with exactly these four top-level keys (each can be an object or null if not applicable):

1. "technicalSchema" – Domain/object types and structure. Include ${targetLangHint} equivalent for source terms.

2. "namingConventions" – Rules for naming and notation.${t.phaseLettersRule}

3. "abbreviationLogic" – SOURCE-language key → TARGET-language object. MANDATORY: All entries MUST be objects with longForm and shortForm (no plain strings). shortForm must be ONLY the target abbreviation (e.g. UPS, NDC SO); it must NOT contain the source key (avoids recursive "matryoshka" replacement). longForm must not contain parentheses; put abbreviation in shortForm only. Technical indices: always Latin (Pinst, Pwork, Pavail).

4. "entityGroups" – Groupings of term variations; prefer ${targetLangHint} canonical form.

DOMAIN HEURISTICS: Electrical/Power → IEC/IEEE terminology. Legal/Contract → conventional legal style in target language.

CRITICAL:
- Return ONLY the JSON object. No markdown code blocks, no explanation before or after.
- Use null for any key where you cannot infer meaningful content.
- Keys in abbreviationLogic and namingConventions must be in the SOURCE language (${sourceLangHint}); values must be in the TARGET language (${targetLangHint}).
- abbreviationLogic: ALL values MUST be objects with longForm and shortForm (no plain strings). shortForm must NOT contain the source key (clean target-only abbreviation).`;

  return expertRoleLine + '\n' + BASE_ROLE + profileTerminologyBlock + profileInstructionsBlock + defaultKnowledgeBlock;
}

/**
 * Build user prompt for Document DNA generation.
 */
export function buildDnaGenerateUserPrompt(params: BuildDnaGenerateParams): string {
  const { sourceLocale, targetLocale, sourceLangHint, targetLangHint, documentName, textToAnalyze } = params;
  return `Document name: "${documentName}"
Translation direction: from ${sourceLocale} (${sourceLangHint}) to ${targetLocale} (${targetLangHint}). Identify technical terms and provide translations from ${sourceLocale} to ${targetLocale}. All abbreviation expansions and terminology values in the DNA must be in the target language (${targetLangHint}).

Analyze the following document sample and produce the Document DNA JSON (technicalSchema, namingConventions, abbreviationLogic, entityGroups):

--- BEGIN SAMPLE ---
${textToAnalyze}
--- END SAMPLE ---`;
}

export interface BuildDnaRefineParams {
  sourceLocale: string;
  targetLocale: string;
  documentName: string;
  currentDnaJson: string;
  textToUse: string;
}

/**
 * Build system prompt for Document DNA refinement (refineDocumentDna).
 * Direction-aware so the revisor applies the same three-layer categorization.
 */
export function buildDnaRefineSystemPrompt(params: {
  sourceLocale: string;
  targetLocale: string;
}): string {
  const { sourceLocale, targetLocale } = params;
  const direction = getTranslationDirection(sourceLocale, targetLocale);
  const t = DIRECTIONAL_TEMPLATES[direction];

  const hybridNote = direction === 'en-ru'
    ? ' (3) EN→RU: shortForm = "ПУОСС (ESMP)" style.'
    : '';

  return `You are the Document DNA Revisor (Universal DNA Architect). Your task is to enrich the JSON using the full document text.

DIRECTION: RU → EN: Key = Russian, Value = English. EN → RU: Key = English, Value = Russian. Keys always in SOURCE language; values in TARGET language.

RULES: (1) Technical indices (Руст, Рраб, Ррасп, P_inst, P_work, P_avail): keep Latin in both longForm and shortForm (Pinst, Pwork, Pavail). (2) Fixed enums (Priority, Status): put in technicalSchema/namingConventions; use nominative case in target.${hybridNote} (4) Institutional: ADB→АБР, MERK→МЭ РК, NDC SO→НДЦ СО; "Requires a waiver" → "Требуется вейвер" or "Требуется освобождение от выполнения условия". (5) abbreviationLogic: every entry MUST be { longForm, shortForm }; no plain strings; shortForm must NOT contain the source key (target-only abbreviation). technicalSchema: include Market, Dispatch, Protection, Social, Environmental. namingConventions: dates (DD Month YYYY), phases (A, B, C); for institutional docs add definitionsFormatting and abbreviationRedundancy.
${INSTITUTIONAL_ADB_IFC}
${INSTITUTIONAL_UES_KZ}

CHAIN OF THOUGHT (mandatory): First, write a DRAFT section where you list every abbreviation and its exact definition as found in the document, with clause/section reference. Only after this draft, output the final JSON.

SYNTACTIC BOUNDARIES: Use structure to detect term boundaries. For patterns like "[digits.] [Noun phrase], [modifier]" (e.g. "11.02.05. Подвеска провода, на 35 км"), extract the noun phrase as one term and the leading digits as section convention; do not split the noun phrase or merge unrelated words.

1. SCAN: Scan the entire document text for definitions of any remaining null or unclear terms. Use explicit definitions, parenthetical explanations, table headers, and lists.

2. TRANSLATE: Translate source-language terms into the TARGET language. Keep keys in SOURCE language and values in TARGET language.

3. PRIORITY RULES: Record unique definitions (e.g. acronyms expanded only in this document) in abbreviationLogic or namingConventions.

4. FILL NULLS: Fill all nulls using evidence from the text only. Do not invent terms.

5. FORCE DEFINITIONS: Every abbreviationLogic entry MUST be an object: { "longForm": "Full name in target language without parentheses", "shortForm": "ABBR or ПУОСС (ESMP)" }. Technical indices: Руст → shortForm "Pinst", Рраб → "Pwork", Ррасп → "Pavail".

6. EXPLICIT ENTITY FILLING: Do not leave technicalSchema categories (market, dispatch, protection, social, environmental) empty.

7. TERMINOLOGY ENFORCEMENT: Prefer "Net tie-line flow" for сальдо-переток and "Coincident Peak" for совмещенный максимум when target is English.

Output format: First your DRAFT (abbreviation → definition with clause ref). Then a line "FINAL JSON:" and on the following lines the complete JSON with keys: technicalSchema, namingConventions, abbreviationLogic, entityGroups. No markdown code fences around the JSON.`;
}

/**
 * Build user prompt for Document DNA refinement.
 */
export function buildDnaRefineUserPrompt(params: BuildDnaRefineParams): string {
  const { sourceLocale, targetLocale, documentName, currentDnaJson, textToUse } = params;
  const direction = getTranslationDirection(sourceLocale, targetLocale);
  const isTargetRussian = targetLocale.toLowerCase().startsWith('ru');
  const shortFormNote = isTargetRussian
    ? ' For EN→RU: shortForm = Russian abbreviation + English in brackets, e.g. "ПУОСС (ESMP)".'
    : '';

  return `Document: "${documentName}"
Translation direction: from ${sourceLocale} to ${targetLocale}. Keys in JSON must be in source language; values in target language.

Current Document DNA (JSON):
${currentDnaJson}

Document text (or stratified sample):
--- BEGIN TEXT ---
${textToUse}
--- END TEXT ---

Review the JSON against the document, fix terms and fill nulls. abbreviationLogic: ALL entries MUST be objects (no strings). Each object has "longForm" (full name in target language, NO parentheses) and "shortForm" (abbreviation only).${shortFormNote} Move content from parentheses into shortForm; do not leave parentheses in longForm. Technical indices: keep Latin (Pinst, Pwork, Pavail). Fixed enums: use nominative case. Return only the corrected JSON with keys: technicalSchema, namingConventions, abbreviationLogic, entityGroups.`;
}

/** Max number of term pairs to send to the QC judge (LLM-as-judge). */
export const DNA_QC_SAMPLE_SIZE = 10;

/** Minimum score (1–5) to keep a term; below this the term is filtered out. */
export const DNA_QC_MIN_SCORE = 3;

export interface DnaQcTermEntry {
  key: string;
  longForm: string;
  shortForm: string;
}

/**
 * Build system prompt for DNA term QC (LLM-as-judge on extracted term pairs).
 * Used to filter low-quality extractions before saving Document DNA.
 */
export function buildDnaQcJudgeSystemPrompt(params: {
  sourceLocale: string;
  targetLocale: string;
}): string {
  const { sourceLocale, targetLocale } = params;
  return `You are a terminology quality judge. You will receive a list of term pairs: source term (${sourceLocale}) → target longForm and shortForm (${targetLocale}). For each pair, score from 1 to 5:
- 5: Correct and relevant domain term; translation is accurate and appropriate.
- 4: Good; minor style or convention quibble.
- 3: Acceptable; usable but not ideal.
- 2: Weak; likely incorrect or too generic.
- 1: Bad; wrong translation, not a real term, or irrelevant.

Score strictly. Output ONLY a JSON object mapping each source term (exact key as given) to its score (number 1–5). Example: {"term1": 4, "term2": 2}. No explanation, no markdown.`;
}

/**
 * Build user prompt for DNA term QC: list of term entries to score.
 */
export function buildDnaQcJudgeUserPrompt(params: {
  entries: DnaQcTermEntry[];
  sourceLocale: string;
  targetLocale: string;
}): string {
  const { entries, sourceLocale, targetLocale } = params;
  const lines = entries.map(
    (e) => `- "${e.key}" → longForm: "${e.longForm}", shortForm: "${e.shortForm}"`
  ).join('\n');
  return `Source language: ${sourceLocale}. Target language: ${targetLocale}.\n\nScore each term pair (1–5). Return only a JSON object: key = source term in quotes, value = number.\n\n${lines}`;
}

/** Response shape for glossary-from-document extraction. */
export interface GlossaryExtractPair {
  sourceTerm: string;
  targetTerm: string;
}

/**
 * Build system prompt for extracting glossary term pairs from document text (LLM extraction into glossary).
 */
export function buildGlossaryExtractSystemPrompt(params: {
  sourceLocale: string;
  targetLocale: string;
}): string {
  const { sourceLocale, targetLocale } = params;
  return `You are a terminology extractor. From the given document text, identify key domain term pairs: source term (${sourceLocale}) → target term (${targetLocale}). Include technical terms, abbreviations (with expansion in target), and named entities. Output ONLY a JSON array of objects, each with exactly "sourceTerm" and "targetTerm" (strings). Example: [{"sourceTerm":"сальдо-переток","targetTerm":"Net tie-line flow"},{"sourceTerm":"Руст","targetTerm":"Pinst (installed capacity)"}]. No explanation, no markdown. Extract up to 50 most important term pairs.`;
}

/**
 * Build user prompt for glossary extraction: document text to analyze.
 */
export function buildGlossaryExtractUserPrompt(params: {
  documentName: string;
  textSample: string;
  sourceLocale: string;
  targetLocale: string;
}): string {
  const { documentName, textSample, sourceLocale, targetLocale } = params;
  return `Document: "${documentName}". Direction: ${sourceLocale} → ${targetLocale}.\n\nExtract term pairs from this text. Return only a JSON array of {"sourceTerm":"...","targetTerm":"..."}.\n\n--- BEGIN TEXT ---\n${textSample}\n--- END TEXT ---`;
}
