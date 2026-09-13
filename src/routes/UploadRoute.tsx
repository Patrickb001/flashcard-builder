import { useNavigate, useSearchParams } from 'react-router-dom';
import Uploader from '../components/Uploader';
import type { ReviewDraft } from './reviewDraft';

/** Choosing a document, then handing the parsed result to the review screen. */
export default function UploadRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Set when the upload started from inside a folder on the library.
  const folderId = searchParams.get('folder') ?? undefined;

  return (
    <Uploader
      onParsed={(sections, fileName, sourceType, ai, notice, sourceUrls) => {
        const draft: ReviewDraft = { sections, fileName, sourceType, ai, notice, sourceUrls, folderId };
        navigate('/review', { state: draft });
      }}
      onCancel={() => navigate('/')}
    />
  );
}
