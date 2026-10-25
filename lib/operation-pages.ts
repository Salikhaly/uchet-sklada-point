type PageError={message:string};
type Page<T>={data:T[]|null;error:PageError|null};

// Fetch until an empty page, including when the API caps a page below our size.
// Publish only a complete result so an error cannot look like missing history.
export async function readOperationPages<T>(fetchPage:(from:number,to:number)=>PromiseLike<Page<T>>,pageSize=200):Promise<Page<T>>{
  const all:T[]=[];
  for(;;){
    const page=await fetchPage(all.length,all.length+pageSize-1);
    if(page.error)return {data:null,error:page.error};
    if(!page.data?.length)return {data:all,error:null};
    all.push(...page.data);
  }
}
