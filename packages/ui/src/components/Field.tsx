"use client";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
interface Common { label: string; hint?: string; error?: string }
export function TextField({ label, hint, error, id, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const i = id ?? rest.name ?? label;
  return (
    <div className="field">
      <label htmlFor={i}>{label}</label>
      <input id={i} className="input" aria-invalid={error ? "true" : undefined} aria-describedby={error ? i + "-err" : undefined} {...rest} />
      {error ? <span id={i + "-err"} className="field-error" role="alert">{error}</span> : hint ? <span className="t-small t-muted">{hint}</span> : null}
    </div>
  );
}
export function SelectField({ label, hint, error, id, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const i = id ?? rest.name ?? label;
  return (
    <div className="field">
      <label htmlFor={i}>{label}</label>
      <select id={i} className="input" aria-invalid={error ? "true" : undefined} {...rest}>{children}</select>
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="t-small t-muted">{hint}</span> : null}
    </div>
  );
}
export function TextArea({ label, hint, error, id, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const i = id ?? rest.name ?? label;
  return (
    <div className="field">
      <label htmlFor={i}>{label}</label>
      <textarea id={i} className="input" aria-invalid={error ? "true" : undefined} {...rest} />
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="t-small t-muted">{hint}</span> : null}
    </div>
  );
}
