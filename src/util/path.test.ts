import { describe, expect, it } from 'vitest';
import { basename, dirname, resolvePath } from './path.js';

describe('dirname', () => {
  it('returns the directory portion', () => {
    expect(dirname('EPUB/css/main.css')).toBe('EPUB/css');
  });

  it('returns empty string when there is no directory component', () => {
    expect(dirname('mimetype')).toBe('');
  });
});

describe('basename', () => {
  it('returns the final segment', () => {
    expect(basename('EPUB/css/main.css')).toBe('main.css');
  });

  it('returns the whole path when there is no directory component', () => {
    expect(basename('mimetype')).toBe('mimetype');
  });
});

describe('resolvePath', () => {
  it('resolves against the directory of the base file, not the base itself', () => {
    expect(resolvePath('EPUB/package.opf', 'images/cover.png')).toBe('EPUB/images/cover.png');
  });

  it('walks out of the base directory for ..', () => {
    expect(resolvePath('EPUB/css/main.css', '../fonts/f.ttf')).toBe('EPUB/fonts/f.ttf');
  });

  it('treats a leading slash as container-absolute', () => {
    expect(resolvePath('EPUB/css/main.css', '/images/cover.png')).toBe('images/cover.png');
  });

  // The cases below are why CSSValidator's private resolver could not simply be
  // deleted in favour of this one: with the base file at the container root its
  // directory is empty, and an unnormalized './' or '../' leaks into the result
  // and then fails to match any manifest href.
  it('normalizes . and .. when the base file sits at the container root', () => {
    expect(resolvePath('style.css', './font.ttf')).toBe('font.ttf');
    expect(resolvePath('style.css', '../fonts/f.ttf')).toBe('fonts/f.ttf');
  });

  it('collapses empty segments from doubled slashes', () => {
    expect(resolvePath('EPUB/style.css', 'a//b.ttf')).toBe('EPUB/a/b.ttf');
  });

  it('leaves a plain relative path untouched at the container root', () => {
    expect(resolvePath('style.css', 'font.ttf')).toBe('font.ttf');
  });
});
