for p in ['drizzle/0000_init.sql','src/db/schema.ts']:
    try:
        with open(p,'r',encoding='utf-8',errors='ignore') as f: s=f.read()
        old=\"CASE WHEN variant_id IS NULL THEN '__________________________' ELSE variant_id END\"
        s=s.replace(old,\"COALESCE(variant_id, '')\")
        with open(p,'w',encoding='utf-8') as f: f.write(s)
        print('fixed',p)
    except Exception as e:
        print('err',e)
