// Incremental tsc builds retain deleted modules. Remove the retired private chat
// outputs so upgrading a checkout cannot put a second runtime in the tarball.
import {rm} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const dist=join(dirname(fileURLToPath(import.meta.url)),'../dist')
await rm(join(dist,'bundled-chat'),{recursive:true,force:true})
for(const module of [
 ...['host','worker','runtime','catalog','errors'].map(name=>'extensions/bundled-'+name),
 ...['telegram','slack','discord'].map(name=>'chat/providers/'+name+'/bundled-adapter'),
])for(const suffix of ['.js','.js.map','.d.ts'])await rm(join(dist,module+suffix),{force:true})
