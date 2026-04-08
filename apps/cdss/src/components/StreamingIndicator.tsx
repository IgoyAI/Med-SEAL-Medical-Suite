import { SkeletonText } from '@carbon/react';

export default function StreamingIndicator() {
  return (
    <div className="streaming-indicator">
      <SkeletonText paragraph lineCount={2} width="80%" />
    </div>
  );
}
