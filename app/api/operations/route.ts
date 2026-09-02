import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function normalizeItems(items: any[]) {
  return (Array.isArray(items) ? items : []).map((i:any) => ({
    product_id: i.product_id || null,
    name: String(i.name || '').trim(),
    kg: Number(i.kg),
    price: Number(i.price),
    wasteKg: Number(i.wasteKg || 0),
  }));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createClient();
    const type = body.type === 'SHIPMENT' ? 'SHIPMENT' : 'ARRIVAL';
    const contractorId = type === 'SHIPMENT' ? (body.contractorId || null) : (body.contractorId || null);
    const operationDate = String(body.operationDate || '');
    const items = normalizeItems(body.items);
    if (!operationDate) return NextResponse.json({error:'Дата операции обязательна'},{status:400});
    if (!items.length) return NextResponse.json({error:'Нет товаров для операции'},{status:400});

    const { data, error } = await supabase.rpc('post_operation', {
      p_type: type,
      p_contractor_id: contractorId,
      p_operation_date: operationDate,
      p_items: items,
      p_note: type === 'SHIPMENT' && !contractorId ? 'Обычная продажа без контрагента' : null,
    });
    if (error) return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({ok:true,operationId:data});
  } catch (e:any) {
    return NextResponse.json({error:e?.message || 'Ошибка сохранения операции'},{status:500});
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createClient();
    const opId = String(body.operationId || '');
    if (!opId) return NextResponse.json({error:'Операция не указана'},{status:400});
    const items = normalizeItems(body.items);
    const { data, error } = await supabase.rpc('update_operation', {
      p_operation_id: opId,
      p_contractor_id: body.contractorId || null,
      p_operation_date: String(body.operationDate || ''),
      p_items: items,
      p_note: body.note || null,
    });
    if (error) return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({ok:true,operationId:data});
  } catch (e:any) {
    return NextResponse.json({error:e?.message || 'Ошибка изменения операции'},{status:500});
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createClient();
    const { error } = await supabase.rpc('delete_operation', { p_operation_id: String(body.operationId || '') });
    if (error) return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({ok:true});
  } catch (e:any) {
    return NextResponse.json({error:e?.message || 'Ошибка удаления операции'},{status:500});
  }
}
