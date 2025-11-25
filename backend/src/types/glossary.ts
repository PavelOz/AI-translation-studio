/**
 * Glossary enforcement mode for AI translation.
 * 
 * - 'off': Glossary is ignored during translation
 * - 'strict_source': Glossary is enforced only when the term appears literally in the source segment
 * - 'strict_semantic': Semantic/experimental mode (to be implemented)
 */
export type GlossaryMode = 'off' | 'strict_source' | 'strict_semantic';



