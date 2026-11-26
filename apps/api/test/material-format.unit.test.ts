import { describe, expect, it } from 'vitest';
import { validateMaterialFile } from '../src/report/material-format';

const check = (name: string, buffer: Buffer) => validateMaterialFile({ originalname: name, size: buffer.length, buffer });
describe('monthly material formats', () => {
  it('recognizes Office types using their actual package parts', () => {
    for (const [extension, part] of [['docx', 'word/document.xml'], ['pptx', 'ppt/presentation.xml'], ['xlsx', 'xl/workbook.xml']]) {
      const buffer = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from('[Content_Types].xml ' + part)]);
      expect(check('report.' + extension, buffer).ext).toBe(extension);
    }
    expect(() => check('report.pptx', Buffer.from('%PDF-1.4'))).toThrow();
    expect(() => check('report.xlsx', Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from('[Content_Types].xml word/document.xml')]))).toThrow();
  });
  it('accepts presentations above 20 MiB but rejects 50 MiB exactly', () => {
    const buffer = Buffer.alloc(21 * 1024 * 1024);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buffer);
    expect(check('report.ppt', buffer).ext).toBe('ppt');
    expect(() => check('report.doc', buffer)).toThrow();
    const limit = Buffer.alloc(50 * 1024 * 1024);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(limit);
    expect(() => check('report.ppt', limit)).toThrow();
  });
  it('validates text and image content and rejects empty/renamed executable files', () => {
    expect(check('notes.txt', Buffer.from('本月成果 https://example.com/report')).mime).toContain('text/plain');
    expect(check('proof.png', Buffer.from('89504e470d0a1a0a', 'hex')).mime).toBe('image/png');
    expect(check('proof.jpg', Buffer.from('ffd8ff', 'hex')).mime).toBe('image/jpeg');
    for (const [name, bytes] of [['empty.txt', Buffer.alloc(0)], ['bad.txt', Buffer.from([0xff])], ['binary.txt', Buffer.from([0])], ['fake.png', Buffer.from('MZ')], ['run.exe', Buffer.from('MZ')]] as const)
      expect(() => check(name, bytes)).toThrow();
  });
});
