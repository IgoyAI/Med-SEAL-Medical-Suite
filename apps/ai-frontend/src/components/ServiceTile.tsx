import type { Service } from '../services';
import { ClickableTile, Tag } from '@carbon/react';
import { ArrowRight, Hospital, DataBase, ChartLineData } from '@carbon/icons-react';

const SERVICE_ICONS: Record<string, typeof Hospital> = {
    openemr: Hospital,
    medplum: DataBase,
    langfuse: ChartLineData,
};

interface Props {
    service: Service;
    status: 'checking' | 'up' | 'down';
    onLaunch: () => void;
}

export default function ServiceTile({ service, status, onLaunch }: Props) {
    const statusLabel = status === 'checking' ? 'Checking...' : status === 'up' ? 'Running' : 'Offline';
    const tagType = status === 'up' ? 'green' as const : status === 'down' ? 'red' as const : 'gray' as const;
    const Icon = SERVICE_ICONS[service.id] || Hospital;

    return (
        <ClickableTile className="service-card" onClick={onLaunch}>
            <div className="service-card__icon" style={{ background: service.bgColor, color: service.color }}>
                <Icon size={28} />
            </div>
            <div className="service-card__name">{service.name}</div>
            <div className="service-card__desc">{service.desc}</div>
            <div className="service-card__footer">
                <span className="service-card__launch">
                    Launch <ArrowRight size={14} />
                </span>
                <Tag type={tagType} size="sm">
                    <span
                        className={`status-dot status-dot--${status}`}
                        style={{ display: 'inline-block', marginRight: 4 }}
                        role="img"
                        aria-label={`Status: ${statusLabel}`}
                    />
                    {statusLabel}
                </Tag>
            </div>
        </ClickableTile>
    );
}
