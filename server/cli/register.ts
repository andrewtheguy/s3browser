#!/usr/bin/env bun
import bcrypt from 'bcrypt';
import { parseArgs } from 'util';
import { createUser, getUserByUsername, closeDb } from '../db/index.js';

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

async function promptPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  // Read password from stdin in raw mode to hide input
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  return new Promise((resolve) => {
    let password = '';

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char: string) => {
      // Handle Ctrl+C
      if (char === '\u0003') {
        stdin.setRawMode(wasRaw || false);
        process.stdout.write('\n');
        process.exit(1);
      }

      // Handle Enter
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(password);
        return;
      }

      // Handle Backspace
      if (char === '\u007f' || char === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
        return;
      }

      // Add character to password
      password += char;
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      username: {
        type: 'string',
        short: 'u',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
S3 Browser User Registration

Usage:
  bun run register -u <username>
  bun run register --username <username>

Options:
  -u, --username  Username for the new account (required)
  -h, --help      Show this help message

The password will be prompted securely (hidden input).
Minimum password length: ${MIN_PASSWORD_LENGTH} characters.
    `.trim());
    process.exit(0);
  }

  if (!values.username) {
    console.error('Error: --username (-u) is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  const username = values.username.trim();

  // Validate username
  if (username.length < 3) {
    console.error('Error: Username must be at least 3 characters');
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    console.error('Error: Username can only contain letters, numbers, underscores, and hyphens');
    process.exit(1);
  }

  // Check if user already exists
  try {
    const existingUser = getUserByUsername(username);
    if (existingUser) {
      console.error(`Error: User '${username}' already exists`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error: Failed to check existing user:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Prompt for password
  const password = await promptPassword('Enter password: ');

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Error: Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    process.exit(1);
  }

  // Confirm password
  const confirmPassword = await promptPassword('Confirm password: ');

  if (password !== confirmPassword) {
    console.error('Error: Passwords do not match');
    process.exit(1);
  }

  // Hash password and create user
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createUser(username, passwordHash);
    console.log(`\nUser '${user.username}' created successfully!`);
  } catch (error) {
    console.error('Error: Failed to create user:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

void main();
