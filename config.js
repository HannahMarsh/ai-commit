
import * as dotenv from 'dotenv';
import { getArgs } from './helpers.js';

dotenv.config();

export const args = getArgs();

/**
 * possible values: 'openai', 'groq', or 'ollama'
 */
export const AI_PROVIDER = args.AI_PROVIDER || 'groq'


/** 
 * name of the model to use.
 * can use this to switch between different local models.
 */
export const MODEL = args.MODEL || 'llama3-8b-8192';