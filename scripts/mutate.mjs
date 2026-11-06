// Mutation check ("ломающая проверка"): break ONE thing at a time in a COPY of the project and make sure the tests notice.
// A mutant that survives means a test is too weak (or the code is dead). Used in 2pack: the first run let 2 of 19
// mutants through, which exposed two tests that passed for the wrong reason.
//
// Usage:   node mutate.mjs <projectDir> <mutations.json> [workDir]
//   mutations.json: [["name", "relative/file.ts", "exact text to replace", "replacement"], ...]
//   (replacement may be "" to delete the text, e.g. to drop a bounds check)
// The project is copied (src, tests, config) into workDir (default: a temp folder); node_modules is linked, not copied.
// The test command is `npx vitest run`; change TEST below for another runner.
// Never mutates the real project. A pattern that is not found counts as a setup error (it means the code moved).
//
// Идея: ломаем по одной проверке в КОПИИ и смотрим, что тесты падают. Выживший мутант = слабый тест или мёртвый код.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'npx vitest run';
const COPY = ['src', 'tests', 'package.json', 'tsconfig.json', 'vitest.config.ts'];

const [projectArg, mutationsArg, workArg] = process.argv.slice(2);
if (!projectArg || !mutationsArg) {
    console.error('usage: node mutate.mjs <projectDir> <mutations.json> [workDir]');
    process.exit(2);
}
const project = resolve(projectArg);
const mutations = JSON.parse(readFileSync(resolve(mutationsArg), 'utf8'));
const work = workArg ? resolve(workArg) : mkdtempSync(join(tmpdir(), 'mutants-'));

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const f of COPY) if (existsSync(join(project, f))) cpSync(join(project, f), join(work, f), { recursive: true });
symlinkSync(join(project, 'node_modules'), join(work, 'node_modules'), 'junction'); // 'junction' needs no admin rights on Windows

let bad = 0;
for (const [name, file, from, to] of mutations) {
    const path = join(work, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(from)) {
        console.log(`SETUP ERROR (pattern not found): ${name}`);
        bad++;
        continue;
    }
    writeFileSync(path, original.replace(from, to));
    let caught = false;
    try {
        execSync(TEST, { cwd: work, stdio: 'pipe', timeout: 120_000 });
    } catch {
        caught = true;
    }
    writeFileSync(path, original);
    console.log(`${caught ? 'caught   ' : 'SURVIVED '}${name}`);
    if (!caught) bad++;
}
console.log(bad === 0 ? '\nall mutants caught' : `\n${bad} mutant(s) survived or failed to apply`);
process.exit(bad === 0 ? 0 : 1);
