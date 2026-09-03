interface PipelineLogoProps {
  tone?: 'dark' | 'light';
  compact?: boolean;
  caption?: string;
  className?: string;
}

export default function PipelineLogo({
  tone = 'dark',
  compact = false,
  caption = 'Recruiting operations',
  className = ''
}: PipelineLogoProps) {
  return (
    <div className={`pipeline-logo pipeline-logo--${tone}${compact ? ' pipeline-logo--compact' : ''}${className ? ` ${className}` : ''}`}>
      <img
        className="pipeline-logo__mark"
        src="/pipelineos-mark.svg"
        alt=""
        aria-hidden="true"
      />
      <span className="pipeline-logo__copy">
        <span className="pipeline-logo__name">PipelineOS</span>
        {!compact && <span className="pipeline-logo__caption">{caption}</span>}
      </span>
    </div>
  );
}
