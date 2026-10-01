import { Console, Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { CommandError } from './daemon';

const zshScript = (
	names: ReadonlyArray<string>,
) => `eval "$(command devsess --completions zsh)"
if (( $+functions[_devsess] )); then
  functions[_devsess_base]=$functions[_devsess]
  _devsess() {
    local -a callback_args candidates
    local i=3 word positional=0 end_options=0
    if [[ $words[2] == start ]]; then
      while (( i < CURRENT )); do
        word=$words[i]
        if (( end_options )); then
          positional=1
          break
        fi
        case "$word" in
          --project|--config|--service|-s|--log-level|--completions)
            (( i++ ))
            if (( i >= CURRENT )); then
              _devsess_base "$@"
              return
            fi
            if [[ $word == --project || $word == --config ]]; then
              callback_args+=("$word" "$words[i]")
            fi
            ;;
          --project=*|--config=*) callback_args+=("$word") ;;
          --service=*|-s?*|--log-level=*|--completions=*) ;;
          --) end_options=1 ;;
          --help|-h|--version|-v|--wizard) ;;
          -*) _devsess_base "$@"; return ;;
          *) positional=1; break ;;
        esac
        (( i++ ))
      done
      if (( ! positional )) && { (( end_options )) || [[ $words[CURRENT] != -* ]]; }; then
        candidates=("\${(@f)$(command devsess list --names "$callback_args[@]" 2>/dev/null)}")
        [[ -n $candidates[1] ]] || return
        compadd -- "$candidates[@]"
        return
      fi
    fi
    _devsess_base "$@"
  }
  compdef _devsess ${names.join(' ')}
fi
`;

const bashScript = (
	names: ReadonlyArray<string>,
) => `eval "$(command devsess --completions bash)"
_devsess_custom_completions() {
  local -a callback_args=()
  local i=2 word positional=0 end_options=0 candidate
  if [[ "\${COMP_WORDS[1]}" == start ]]; then
    while (( i < COMP_CWORD )); do
      word=\${COMP_WORDS[i]}
      if (( end_options )); then
        positional=1
        break
      fi
      case "$word" in
        --project|--config|--service|-s|--log-level|--completions)
          (( i++ ))
          if [[ "\${COMP_WORDS[i]}" == = ]]; then
            (( i++ ))
          fi
          if (( i >= COMP_CWORD )); then
            _devsess
            return
          fi
          if [[ $word == --project || $word == --config ]]; then
            callback_args+=("$word" "\${COMP_WORDS[i]}")
          fi
          ;;
        --project=*|--config=*) callback_args+=("$word") ;;
        --service=*|-s?*|--log-level=*|--completions=*) ;;
        --) end_options=1 ;;
        --help|-h|--version|-v|--wizard) ;;
        -*) _devsess; return ;;
        *) positional=1; break ;;
      esac
      (( i++ ))
    done
    if (( ! positional )) && { (( end_options )) || [[ "\${COMP_WORDS[COMP_CWORD]}" != -* ]]; }; then
      COMPREPLY=()
      while IFS= read -r candidate; do
        if [[ $candidate == "\${COMP_WORDS[COMP_CWORD]}"* ]]; then
          COMPREPLY+=("$candidate")
        fi
      done < <(command devsess list --names "\${callback_args[@]}" 2>/dev/null)
      return
    fi
  fi
  _devsess
}
complete -F _devsess_custom_completions ${names.join(' ')}
`;

const fishScript = (
	names: ReadonlyArray<string>,
) => `command devsess --completions fish | source
function __devsess_start_presets --argument-names mode
  set -l words (commandline -opc)
  test "$words[2]" = start; or return 1
  set -l callback_args
  set -l i 3
  set -l end_options 0
  while test $i -le (count $words)
    set -l word $words[$i]
    test $end_options -eq 0; or return 1
    switch "$word"
      case --project --config --service -s --log-level --completions
        set i (math $i + 1)
        test $i -le (count $words); or return 1
        if contains -- "$word" --project --config
          set -a callback_args "$word" "$words[$i]"
        end
      case '--project=*' '--config=*'
        set -a callback_args "$word"
      case '--service=*' '-s?*' '--log-level=*' '--completions=*'
      case --
        set end_options 1
      case --help -h --version -v --wizard
      case '-*'
        return 1
      case '*'
        return 1
    end
    set i (math $i + 1)
  end
  if test $end_options -eq 0; and string match -q -- '-*' (commandline -ct)
    return 1
  end
  if test "$mode" = query
    return 0
  end
  command devsess list --names $callback_args 2>/dev/null
end
complete -c devsess -f -n '__devsess_start_presets query' -a '(__devsess_start_presets candidates)'
${names
	.filter((name) => name !== 'devsess')
	.map((name) => `complete -c ${name} -w devsess`)
	.join('\n')}
`;

export const completionsCommand = Command.make(
	'completions',
	{
		shell: Argument.choice('shell', ['zsh', 'bash', 'fish']),
		aliases: Flag.string('alias').pipe(
			Flag.withDescription('Also register completion for this command name.'),
			Flag.atLeast(0),
		),
	},
	(input) =>
		Effect.gen(function* () {
			for (const alias of input.aliases) {
				if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(alias))
					return yield* new CommandError({
						message: `Invalid completion alias ${alias}. Use letters, digits, underscores, or hyphens, starting with a letter or underscore.`,
					});
			}
			const names = [...new Set(['devsess', ...input.aliases])];
			const script =
				input.shell === 'zsh'
					? zshScript(names)
					: input.shell === 'bash'
						? bashScript(names)
						: fishScript(names);
			yield* Console.log(script);
		}),
).pipe(
	Command.withDescription('Print shell completion with local start presets.'),
);
