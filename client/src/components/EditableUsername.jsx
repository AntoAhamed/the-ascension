import { useState } from 'react';
import { Check, Edit2, X } from 'lucide-react';

export function EditableUsername({ username, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleStart = () => {
    setValue(username);
    setError(null);
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setError(null);
  };

  const handleSave = async () => {
    const name = value.trim();
    if (name.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
      setError('Username can only use letters, numbers, and underscores (3-20 chars)');
      return;
    }
    if (name === username) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name);
      setEditing(false);
    } catch (err) {
      setError(err?.message || 'Failed to update username');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="rounded-lg border border-white/[0.1] bg-void-950/80 px-3 py-1 font-display text-2xl font-black text-white outline-none focus:border-neon-cyan/60 focus:ring-1 focus:ring-neon-cyan/30 sm:text-3xl"
            maxLength={20}
            autoFocus
            disabled={saving}
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg p-2 text-emerald-400 transition-colors hover:bg-emerald-400/10 disabled:opacity-50"
            title="Save"
            aria-label="Save username"
          >
            <Check size={18} />
          </button>
          <button
            onClick={handleCancel}
            disabled={saving}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={18} />
          </button>
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <h1 className="font-display text-2xl font-black text-white sm:text-3xl">
        Welcome back, <span className="text-gradient">{username}</span>
      </h1>
      <button
        onClick={handleStart}
        className="rounded-lg p-2 text-slate-500 opacity-0 transition-colors hover:bg-white/[0.07] hover:text-slate-200 group-hover:opacity-100"
        title="Edit username"
        aria-label="Edit username"
      >
        <Edit2 size={16} />
      </button>
    </div>
  );
}
