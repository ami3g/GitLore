import React from 'react';

interface TopKSelectorProps {
  value: number;
  onChange: (value: number) => void;
}

const OPTIONS = [3, 5, 8, 10, 15, 20];

export const TopKSelector: React.FC<TopKSelectorProps> = ({ value, onChange }) => {
  return (
    <div className="topk-selector">
      <label className="topk-selector__label">Top-K</label>
      <div className="topk-selector__options">
        {OPTIONS.map((k) => (
          <button
            key={k}
            className={`topk-selector__btn ${value === k ? 'topk-selector__btn--active' : ''}`}
            onClick={() => onChange(k)}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
};
