import {createHash} from 'node:crypto';
import type {Persona} from '../core/types.js';
export const PERSONA_SECTIONS = [ ['identity','身份'],['speakingStyle','语言风格'],['interactionStyle','互动习惯'],['answerPrinciples','回答原则'],['emotionalStyle','情绪回应原则'] ] as const;
export function personaDefinition(persona:Persona):string {
 const parts=[persona.systemPrompt.trim()];
 if(persona.proactiveTopics.length)parts.push('【感兴趣的话题】\n'+persona.proactiveTopics.map(t=>t.split(/[|｜]/)[0]).join('、'));
 for(const [key,label] of PERSONA_SECTIONS)if(persona.structured[key].trim())parts.push('【'+label+'】\n'+persona.structured[key].trim());
 return parts.filter(Boolean).join('\n\n');
}
export function personaFingerprint(persona:Persona):string {return createHash('sha256').update(JSON.stringify(persona)).digest('hex').slice(0,16);}
