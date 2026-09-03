import logoUrl from '../assets/Logo.png';

interface PipelineLogoProps {
  tone?: 'dark' | 'light';
  compact?: boolean;
  full?: boolean;
  caption?: string;
  className?: string;
}

export default function PipelineLogo({
  tone = 'dark',
  compact = false,
  full = false,
  caption = 'Recruiting operations',
  className = ''
}: PipelineLogoProps) {
  return (
    <div className={`pipeline-logo pipeline-logo--${tone}${compact ? ' pipeline-logo--compact' : ''}${full ? ' pipeline-logo--full' : ''}${className ? ` ${className}` : ''}`}>
      {full ? (
        <img className="pipeline-logo__full" src={logoUrl} alt="PipelineOS" />
      ) : (
        <>
          <span className="pipeline-logo__mark" aria-hidden="true">
            <img className="pipeline-logo__source" src={logoUrl} alt="" />
          </span>
          <span className="pipeline-logo__copy">
            <span className="pipeline-logo__name">PipelineOS</span>
            {!compact && <span className="pipeline-logo__caption">{caption}</span>}
          </span>
        </>
      )}
    </div>
  );
}
