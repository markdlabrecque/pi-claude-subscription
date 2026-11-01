export interface AuditSinkOptions {
  extensionRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  warn?: (message: string) => void;
  maxFileBytes?: number;
}
export function createAuditSink(options: AuditSinkOptions): {
  append(record: Record<string, unknown>): Promise<void>;
};
