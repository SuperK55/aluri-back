import { supa } from '../lib/supabase.js';

export function scoreDoctor(doc, p){
  let score=0;
  const specName = (doc.specialty || '').toLowerCase();
  if(p.specialty && specName.includes(String(p.specialty).toLowerCase())) score+=4;
  if(p.city && doc.city && doc.city.toLowerCase()===String(p.city).toLowerCase()) score+=2;
  if(p.language && Array.isArray(doc.languages) && doc.languages.some(l=>String(l).toLowerCase().startsWith(String(p.language).toLowerCase()))) score+=2;
  if(p.need){
    const toks = String(p.need).toLowerCase().split(/[^a-zá-ú0-9]+/i).filter(Boolean);
    const hay = new Set([...(doc.tags||[])]
      .map(t=>String(t).toLowerCase()));
    if(toks.some(t=>hay.has(t))) score+=3;
  }
  return score; // no price/duration bias
}

export async function pickDoctorForLead(p, ownerId = null){
  let query = supa
    .from('doctors')
    .select('*')
    .eq('is_active', true);
  
  // If ownerId is provided, filter by owner
  if (ownerId) {
    query = query.eq('owner_id', ownerId);
  }
  
  const { data, error } = await query.limit(100);
  if(error) throw new Error(error.message);
  const ranked = (data||[]).map(d=>({d,s:scoreDoctor(d,p)})).sort((a,b)=>b.s-a.s);
  return ranked[0]?.d || null;
}
