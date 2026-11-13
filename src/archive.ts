import type { NuxxSyncManager } from './offline/syncManager';

export interface NuxxArchiveExportOptions {
  rootTable?: string;
  rootId?: string;
  includeAssets?: boolean;
  filename?: string;
}

export interface NuxxArchiveUnreferencedAsset {
  zipPath: string;
  folder: string;
  fileName: string;
  url: string;
}

export interface NuxxArchiveImportResult {
  rootTable: string | null;
  rootIds: string[];
  idMap: Record<string, string>;
  importedCounts: Record<string, number>;
  assetsUploaded: number;
  unreferencedAssets: NuxxArchiveUnreferencedAsset[];
}

export interface NuxxArchiveAiKit {
  prompt: string;
  fileExtension: string;
  schemaSummary: Record<string, unknown>;
}

export interface NuxxArchiveJsonPayload {
  tables: Record<string, unknown[]>;
  inlineAssets?: Record<string, string>;
}

/**
 * Universal `.nuxx.zip` / JSON package export, relational import, template download,
 * and AI prompt kit client for Nuxx BaaS (`db.archive`).
 */
export class NuxxDbArchive {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly sync?: NuxxSyncManager;
  private readonly offlineEnabled: boolean;

  constructor(
    url: string,
    headers: Record<string, string>,
    sync?: NuxxSyncManager,
    offlineEnabled: boolean = true
  ) {
    this.url = url.replace(/\/+$/, '');
    // Keep reference to `headers` so `db.setAuthToken()` updates apply automatically
    this.headers = headers;
    this.sync = sync;
    this.offlineEnabled = offlineEnabled;
  }

  private buildAuthOnlyHeaders(): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.headers)) {
      if (key.toLowerCase() === 'content-type') continue;
      if (value !== undefined) {
        clean[key] = value;
      }
    }
    return clean;
  }

  private buildExportQueryString(options?: NuxxArchiveExportOptions): string {
    const params = new URLSearchParams();
    if (options?.rootTable) {
      params.set('rootTable', options.rootTable);
    }
    if (options?.rootId) {
      params.set('rootId', options.rootId);
    }
    if (options?.includeAssets !== undefined) {
      params.set('includeAssets', String(options.includeAssets));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  private async extractErrorPayload(response: Response): Promise<unknown> {
    const raw = await response.text().catch(() => '');
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          const inner = (parsed as { error?: unknown }).error;
          if (inner) return inner;
        }
        return parsed;
      } catch {
        return { message: raw, status: response.status };
      }
    }
    return { message: response.statusText || `HTTP ${response.status}`, status: response.status };
  }

  private parseContentDispositionFilename(disposition: string | null): string | null {
    if (!disposition) return null;

    const utf8Match = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const quotedMatch = disposition.match(/filename="([^"]+)"/i);
    if (quotedMatch?.[1]) {
      return quotedMatch[1];
    }

    const plainMatch = disposition.match(/filename=([^;\s]+)/i);
    if (plainMatch?.[1]) {
      return plainMatch[1].replace(/^['"]|['"]$/g, '');
    }

    return null;
  }

  private triggerBrowserDownload(blob: Blob, filename: string): void {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }

  private async refreshOfflineTables(tables: string[]): Promise<void> {
    if (!this.offlineEnabled || !this.sync || tables.length === 0) {
      return;
    }
    try {
      await this.sync.pullCollectionDeltas(tables);
    } catch {
      // Ignore IndexedDB / sync errors in non-browser or restricted storage environments
    }
  }

  /**
   * Exports a relational `.nuxx.zip` package (tables + optional S3 assets) as a `Blob`.
   */
  async exportZip(
    options?: NuxxArchiveExportOptions
  ): Promise<{ data: Blob | null; error: unknown }> {
    try {
      const qs = this.buildExportQueryString(options);
      const res = await fetch(`${this.url}/archive/export${qs}`, {
        method: 'GET',
        headers: this.buildAuthOnlyHeaders(),
      });

      if (!res.ok) {
        return { data: null, error: await this.extractErrorPayload(res) };
      }

      const blob = await res.blob();
      return { data: blob, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Exports a relational `.nuxx.zip` package and triggers a browser file download.
   */
  async downloadExport(options?: NuxxArchiveExportOptions): Promise<{ error: unknown }> {
    try {
      const qs = this.buildExportQueryString(options);
      const res = await fetch(`${this.url}/archive/export${qs}`, {
        method: 'GET',
        headers: this.buildAuthOnlyHeaders(),
      });

      if (!res.ok) {
        return { error: await this.extractErrorPayload(res) };
      }

      const blob = await res.blob();
      const filename =
        options?.filename ||
        this.parseContentDispositionFilename(res.headers.get('content-disposition')) ||
        'export.nuxx.zip';

      this.triggerBrowserDownload(blob, filename);
      return { error: null };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Imports a `.nuxx.zip` (or `.zip`) package, remapping symbolic IDs, uploading bundled
   * `assets/*` files to S3, and refreshing local IndexedDB deltas for affected collections.
   */
  async importPackage(
    file: File | Blob,
    options?: { rootTable?: string }
  ): Promise<{ data: NuxxArchiveImportResult | null; error: unknown }> {
    try {
      const formData = new FormData();
      const fileName = (file as File).name || 'package.zip';
      formData.append('file', file, fileName);
      if (options) {
        formData.append('options', JSON.stringify(options));
      }

      const res = await fetch(`${this.url}/archive/import`, {
        method: 'POST',
        // Never set Content-Type manually so fetch injects the multipart boundary
        headers: this.buildAuthOnlyHeaders(),
        body: formData,
      });

      if (!res.ok) {
        return { data: null, error: await this.extractErrorPayload(res) };
      }

      const json = (await res.json().catch(() => ({}))) as {
        data?: NuxxArchiveImportResult | null;
        error?: unknown;
      };

      if (json.error) {
        return { data: null, error: json.error };
      }

      const data =
        (json && 'data' in json
          ? json.data
          : (json as unknown as NuxxArchiveImportResult)) ?? null;

      if (data?.importedCounts) {
        await this.refreshOfflineTables(Object.keys(data.importedCounts));
      }

      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Imports an AI-generated or programmatic JSON relational package (`{ tables, inlineAssets? }`)
   * without requiring a binary ZIP file, then refreshes affected offline collections.
   */
  async importJson(
    payload: { tables: Record<string, unknown[]>; inlineAssets?: Record<string, string> } | string,
    options?: { rootTable?: string }
  ): Promise<{ data: NuxxArchiveImportResult | null; error: unknown }> {
    let parsed: { tables: Record<string, unknown[]>; inlineAssets?: Record<string, string> };

    if (typeof payload === 'string') {
      try {
        const candidate: unknown = JSON.parse(payload);
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
          return {
            data: null,
            error: { message: 'El payload JSON de archive debe ser un objeto válido.' },
          };
        }
        parsed = candidate as {
          tables: Record<string, unknown[]>;
          inlineAssets?: Record<string, string>;
        };
      } catch (err) {
        return {
          data: null,
          error: {
            message:
              err instanceof Error
                ? `JSON inválido en importJson: ${err.message}`
                : 'JSON inválido en importJson',
          },
        };
      }
    } else {
      parsed = payload;
    }

    try {
      const res = await fetch(`${this.url}/archive/import`, {
        method: 'POST',
        headers: {
          ...this.buildAuthOnlyHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...parsed,
          ...(options?.rootTable ? { rootTable: options.rootTable } : {}),
        }),
      });

      if (!res.ok) {
        return { data: null, error: await this.extractErrorPayload(res) };
      }

      const json = (await res.json().catch(() => ({}))) as {
        data?: NuxxArchiveImportResult | null;
        error?: unknown;
      };

      if (json.error) {
        return { data: null, error: json.error };
      }

      const data =
        (json && 'data' in json
          ? json.data
          : (json as unknown as NuxxArchiveImportResult)) ?? null;

      if (data?.importedCounts) {
        await this.refreshOfflineTables(Object.keys(data.importedCounts));
      }

      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Fetches a schema-aware AI authoring prompt + schema summary so external LLMs
   * (ChatGPT, Claude, Gemini) can generate valid `.nuxx.zip` or JSON packages for this app.
   */
  async getAiKit(options?: {
    rootTable?: string;
    mode?: 'zip' | 'json';
    brief?: string;
  }): Promise<{ data: NuxxArchiveAiKit | null; error: unknown }> {
    try {
      const params = new URLSearchParams();
      if (options?.rootTable) params.set('rootTable', options.rootTable);
      if (options?.mode) params.set('mode', options.mode);
      if (options?.brief) params.set('brief', options.brief);
      const qs = params.toString();

      const res = await fetch(`${this.url}/archive/ai-kit${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers: this.buildAuthOnlyHeaders(),
      });

      if (!res.ok) {
        return { data: null, error: await this.extractErrorPayload(res) };
      }

      const json = (await res.json().catch(() => ({}))) as {
        data?: NuxxArchiveAiKit | null;
        error?: unknown;
      };

      return {
        data: json.data ?? null,
        error: json.error ?? null,
      };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Downloads a ready-to-fill starter `.nuxx.zip` template (with `README.md`, sample JSON,
   * and `assets/` folders) in the browser.
   */
  async downloadTemplate(options?: {
    rootTable?: string;
    filename?: string;
  }): Promise<{ error: unknown }> {
    try {
      const params = new URLSearchParams();
      if (options?.rootTable) {
        params.set('rootTable', options.rootTable);
      }
      const qs = params.toString();

      const res = await fetch(`${this.url}/archive/template${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers: this.buildAuthOnlyHeaders(),
      });

      if (!res.ok) {
        return { error: await this.extractErrorPayload(res) };
      }

      const blob = await res.blob();
      const filename =
        options?.filename ||
        this.parseContentDispositionFilename(res.headers.get('content-disposition')) ||
        'template.nuxx.zip';

      this.triggerBrowserDownload(blob, filename);
      return { error: null };
    } catch (error) {
      return { error };
    }
  }
}
