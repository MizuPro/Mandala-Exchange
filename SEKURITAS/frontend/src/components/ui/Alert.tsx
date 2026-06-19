import React from 'react';
import { 
  Info, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle 
} from 'lucide-react';

interface AlertProps {
  type?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: React.ReactNode;
  className?: string;
}

export default function Alert({
  type = 'info',
  title,
  message,
  className = ''
}: AlertProps) {
  // Tentukan ikon berdasarkan tipe alert
  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="m-alert-icon" size={16} />;
      case 'warning':
        return <AlertTriangle className="m-alert-icon" size={16} />;
      case 'error':
        return <XCircle className="m-alert-icon" size={16} />;
      case 'info':
      default:
        return <Info className="m-alert-icon" size={16} />;
    }
  };

  const alertClass = [
    'm-alert',
    `m-alert-${type}`,
    className
  ].filter(Boolean).join(' ');

  return (
    <div className={alertClass} role="alert">
      {getIcon()}
      <div className="m-alert-content">
        {title && <h5 className="m-alert-title">{title}</h5>}
        <div className="m-alert-message">{message}</div>
      </div>
    </div>
  );
}
