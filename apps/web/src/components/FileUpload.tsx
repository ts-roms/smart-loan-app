import { useUpload, type UploadSubdir } from '@loan/api-client';
import { Button, useToast } from '@loan/ui';
import { Upload, X } from 'lucide-react';
import { useRef, type ChangeEvent } from 'react';

/**
 * Reusable upload widget. Calls /uploads-api/<subdir>, returns the public
 * URL to the parent via `onUploaded`. Use the lower-level useUpload hook
 * directly when you need custom UI (camera capture, drag-drop, etc.).
 */
export function FileUpload({
  subdir,
  value,
  onUploaded,
  onClear,
  accept = 'image/*,application/pdf',
  label = 'Upload',
  capture,
}: {
  subdir: UploadSubdir;
  value?: string | null;
  onUploaded: (url: string) => void;
  onClear?: () => void;
  accept?: string;
  label?: string;
  /** Hint mobile browsers to open the camera. 'user' = selfie cam. */
  capture?: 'user' | 'environment';
}) {
  const upload = useUpload();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const result = await upload.mutateAsync({ file: f, subdir });
      onUploaded(result.url);
    } catch (err) {
      toast.error((err as Error).message ?? 'Upload failed');
    } finally {
      if (ref.current) ref.current.value = '';
    }
  };

  if (value) {
    const isImage = /\.(jpe?g|png|webp|heic)$/i.test(value);
    return (
      <div className="flex items-center gap-2">
        {isImage ? (
          <a href={value} target="_blank" rel="noopener noreferrer">
            <img
              src={value}
              alt="upload preview"
              className="h-16 w-16 rounded-md border border-white/15 object-cover"
            />
          </a>
        ) : (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-300 hover:underline"
          >
            View file
          </a>
        )}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-white/45 hover:text-rose-300"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        capture={capture}
        onChange={onChange}
        className="hidden"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => ref.current?.click()}
        disabled={upload.isPending}
      >
        <Upload className="h-3 w-3" />
        {upload.isPending ? 'Uploading…' : label}
      </Button>
    </div>
  );
}
