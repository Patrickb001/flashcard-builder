import { useNavigate } from 'react-router-dom';
import Uploader from '../components/Uploader';
import type { ReviewDraft } from './reviewDraft';

/** Choosing a document, then handing the parsed result to the review screen. */
export default function UploadRoute() {
  const navigate = useNavigate();

  return (
    <Uploader
      onParsed={(sections, fileName, sourceType, ai, notice) => {
        const draft: ReviewDraft = { sections, fileName, sourceType, ai, notice };
        navigate('/review', { state: draft });
      }}
      onCancel={() => navigate('/')}
    />
  );
}
