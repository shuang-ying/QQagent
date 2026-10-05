import type { AppConfig, Persona } from '../core/types.js';
import type {ReplyWindow} from './window.js';

export interface TurnContext {
  replyWindow?: ReplyWindow;
  compressionNeeded?: boolean;
  mergedMessageRowIds?: number[];
  id: string;
  scope: string;
  conversationId: string;
  triggerMessageRowId: number;
  triggerMessageId: number;
  historyCutoffId: number;
  configVersion: string;
  config: AppConfig;
  persona: { persona: Persona; source: string };
  signal: AbortSignal;
}
