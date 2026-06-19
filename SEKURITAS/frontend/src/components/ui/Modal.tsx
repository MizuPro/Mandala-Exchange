import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string; // e.g. '500px', '700px'
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Efek 1: Close on Click Outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Efek 2: Close on Escape key press
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Efek 3: Lock body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="m-modal-overlay">
      <div 
        ref={modalRef} 
        className="m-modal-container"
        style={maxWidth ? { maxWidth } : undefined}
      >
        {/* Modal Header */}
        <div className="m-modal-header">
          {title ? (
            <h3 className="m-modal-title">{title}</h3>
          ) : (
            <div style={{ flexGrow: 1 }} />
          )}
          <button 
            type="button" 
            onClick={onClose} 
            className="m-modal-close-btn"
            aria-label="Tutup modal"
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="m-modal-body">
          {children}
        </div>

        {/* Modal Footer (Optional) */}
        {footer && (
          <div className="m-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
