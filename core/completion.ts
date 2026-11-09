import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, CLI_SHORT } from './brand.ts';
import { PROFILE_ID } from './profiles.ts';

// Tab completion for the command itself. The shell script only asks `peerloom __complete WORDS…`; this file decides
// the answers, so completion follows the program without the person reinstalling the script.
export const SUBCOMMANDS = ['join', 'link', 'view', 'harnesses', 'help', 'completion'];
const SHELLS = ['zsh', 'bash', 'fish'];
const JOIN_OPTIONS = ['--harness', '--name', '--timeout'];

export function candidates(words: string[], known: { profileCommands: string[]; harnesses: string[]; profiles: string[] }): string[] {
  const current = words.at(-1) ?? ''; const previous = words.at(-2); const first = words[0];
  const pick = (options: string[]) => options.filter(o => o.startsWith(current));
  if (words.length <= 1) return pick([...SUBCOMMANDS, ...known.profileCommands]);
  if (previous === '--harness') return pick(known.harnesses);
  if (previous === '--as') return pick(known.profiles);
  if (first === 'completion' && words.length === 2) return pick(SHELLS);
  if (current.startsWith('--')) { if (first === 'join') return pick(JOIN_OPTIONS); if (known.profileCommands.includes(first)) return pick(['--as']); }
  return [];
}

export function profileIds(cwd: string): string[] {
  try { return readdirSync(join(cwd, '.agentlink', 'agents'), { withFileTypes: true }).filter(e => e.isDirectory() && PROFILE_ID.test(e.name)).map(e => e.name).sort(); }
  catch { return []; }
}

export function script(shell: 'zsh' | 'bash' | 'fish'): string {
  const names = `${CLI} ${CLI_SHORT}`;
  if (shell === 'zsh') return `#compdef ${names}
# ${CLI} completion for zsh. Add to ~/.zshrc:  eval "$(${CLI} completion zsh)"
# When peerloom has nothing to offer (a --room or --text-file value, free text), the shell's own file completion runs.
_${CLI}() { local -a items; items=("\${(@f)$(${CLI} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}"); items=(\${items:#}); if (( \${#items} )); then compadd -- \$items; else _files; fi }
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i; }
compdef _${CLI} ${names}
`;
  if (shell === 'bash') return `# ${CLI} completion for bash. Add to ~/.bashrc:  eval "$(${CLI} completion bash)"
# The words are sliced before IFS changes: bash 3.2 (macOS) joins a quoted array slice when IFS is not the default.
_${CLI}() { local words=("\${COMP_WORDS[@]:1:COMP_CWORD}"); local IFS=$'\\n'; COMPREPLY=($(${CLI} __complete "\${words[@]}" 2>/dev/null)); }
complete -o default -F _${CLI} ${names}
`;
  return `# ${CLI} completion for fish. Save as ~/.config/fish/completions/${CLI}.fish, or:  ${CLI} completion fish | source
function __${CLI}_complete; set -l items (${CLI} __complete (commandline -opc)[2..-1] (commandline -ct)); if set -q items[1]; printf '%s\\n' $items; else; __fish_complete_path (commandline -ct); end; end
${names.split(' ').map(name => `complete -c ${name} -f -a '(__${CLI}_complete)'`).join('\n')}
`;
}
