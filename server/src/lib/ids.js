import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

// IDs are used to build file paths, so they must match this exact shape.
export const ID_PATTERNS = {
  job: /^job_[a-f0-9]{16}$/,
  project: /^prj_[a-f0-9]{16}$/,
  render: /^rnd_[a-f0-9]{16}$/,
};

export function isValidId(kind, value) {
  return typeof value === 'string' && ID_PATTERNS[kind].test(value);
}
