const zsh = String.raw`#compdef vibe-wrapped vibe-coding-wrapped

if (( ! $+functions[compdef] )); then
  autoload -Uz compinit
  compinit
fi

_vibe_wrapped() {
  local -a commands common generate_options render_options serve_options
  commands=(
    'build:只生成 JSON Report Bundle'
    'render:复用或生成 JSON 并导出静态 HTML'
    'serve:复用或生成 JSON，渲染后启动本地预览'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  common=(
    '--out[报告输出目录]:directory:_directories'
    '--clean[忽略已有 JSON 和事实缓存，完全重新统计]'
    '--help[显示帮助]'
  )
  generate_options=(
    '--year[年度报告]:year:'
    '--month[月度报告]:month (YYYY-MM):'
    '--range[月份范围]:range (YYYY.M-YYYY.M):'
    '*-i[Agent 数据目录，可重复传入]:directory:_directories'
    '*--exclude-input[排除 Agent 数据目录，可重复传入]:directory:_directories'
    '--timezone[IANA 时区]:timezone:'
    '--day-start[统计日开始小时]:hour (0-23):'
    '--privacy[提示词隐私模式]:mode:(full redacted metrics-only)'
    '*--exclude-word[从关键词统计排除词语]:word:'
    '--git[是否读取关联仓库]:mode:(on off)'
  )
  render_options=( $common $generate_options '--theme[渲染主题名称或本地路径]:theme:(official compact)' )
  serve_options=( $render_options '--bind[监听地址与端口，例如 0.0.0.0\:5173]:address:' '--host[监听地址]:host:' '--port[监听端口]:port:' )

  case $words[2] in
    build) _arguments -s $common $generate_options ;;
    render) _arguments -s $render_options ;;
    serve) _arguments -s $serve_options ;;
  esac
}

compdef _vibe_wrapped vibe-wrapped vibe-coding-wrapped`;

const bash = String.raw`_vibe_wrapped_completion() {
  local current command options
  current="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "build render serve" -- "$current") )
    return
  fi
  options="--out --year --month --range -i --exclude-input --timezone --day-start --privacy --exclude-word --git --clean --help"
  [[ $command != build ]] && options="$options --theme"
  [[ $command == serve ]] && options="$options --bind --host --port"
  COMPREPLY=( $(compgen -W "$options" -- "$current") )
}
complete -F _vibe_wrapped_completion vibe-wrapped vibe-coding-wrapped`;

export function completionScript(shell: string): string {
  if (shell === "zsh") return zsh;
  if (shell === "bash") return bash;
  throw new Error(`Unsupported completion shell "${shell}"; expected zsh or bash`);
}
