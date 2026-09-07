"""Chapter links identify a source account and never expose provider permissions."""
import json

import pytest

from test_collection_tools import _node


def test_chapter_link_uses_the_source_account_and_strips_private_context():
    data = _node(r"""
import {chapterLink} from './js/research-tools.js';
const journey={id:'adam-wally',media:{videos:[{id:'851336844',embedUrl:'https://player.vimeo.com/video/851336844?h=permission-value'}]}};
const url=new URL(chapterLink(journey,'851336844','https://example.test/survivor/other?reader=source&saved=1#/survivor/other?q=private&list=private'));
console.log(JSON.stringify({url:url.href,path:url.pathname,search:url.search,hash:url.hash}));
""")
    assert data["url"] == "https://example.test/survivor/adam-wally?chapter=851336844"
    assert data["hash"] == ""
    assert "permission" not in data["url"] and "private" not in data["url"] and "saved" not in data["url"]


@pytest.mark.parametrize("chapter", ["", "wrong", "1&saved=1", "9" * 21, 851336844, None, "123"])
def test_invalid_or_other_account_chapters_are_rejected(chapter):
    data = _node(r"""
import {chapterLink,ChapterLinkError} from './js/research-tools.js';
const journey={id:'adam-wally',media:{videos:[{id:'851336844'}]}};
let rejected=false;
try{chapterLink(journey,VALUE,'https://example.test/')}catch(error){rejected=error instanceof ChapterLinkError}
console.log(JSON.stringify({rejected}));
""".replace("VALUE", json.dumps(chapter)))
    assert data["rejected"]


def test_chapter_tools_keep_missing_or_changed_sources_explicit():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {chapterTools}=await import('./js/ui.js');
const journey={media:{videos:[{id:'851336844'}]}};
const selected=chapterTools(journey,{chapterId:'851336844',chapterMessage:''});
const missing=chapterTools(journey,{chapterId:'123',chapterMessage:''});
const invalid=chapterTools(journey,{chapterId:null,chapterMessage:'Invalid <script>source</script>.'});
console.log(JSON.stringify({
 selected:selected.includes('Copy chapter link')&&selected.includes('Clear chapter selection'),
 missing:missing.includes('no longer listed')&&!missing.includes('Copy chapter link'),
 invalid:invalid.includes('&lt;script&gt;')&&!invalid.includes('<script>'),
 recovery:missing.includes('data-act="clear-chapter"'),
 noPlayer:![selected,missing,invalid].some(html=>html.includes('<iframe')),
}));
""")
    assert all(data.values())


def test_chapter_sharing_and_media_validation_do_not_change_source_data():
    data = _node(r"""
import {chapterLink} from './js/research-tools.js';
import {normalizeProfileMedia,playerURL} from './js/media.js';
const source={images:[],videos:[{id:'851336844',title:'Chapter 6',embed_url:'https://player.vimeo.com/video/851336844?h=existingpermission',status:'captioned'}]};
const before=JSON.stringify(source),media=normalizeProfileMedia(source);
const journey={id:'adam-wally',media};
chapterLink(journey,'851336844','https://example.test/');
const player=new URL(playerURL(media.videos[0]));
console.log(JSON.stringify({preserved:JSON.stringify(source)===before,permission:player.searchParams.get('h'),autoplay:player.searchParams.get('autoplay'),dnt:player.searchParams.get('dnt')}));
""")
    assert data == {"preserved": True, "permission": "existingpermission", "autoplay": "1", "dnt": "1"}


def test_missing_account_or_media_identity_cannot_produce_a_chapter_link():
    data = _node(r"""
import {chapterLink,ChapterLinkError} from './js/research-tools.js';
const cases=[null,{id:'person'},{media:{videos:[{id:'123'}]}},{id:'../person',media:{videos:[{id:'123'}]}}];
console.log(JSON.stringify(cases.map(journey=>{
 try{chapterLink(journey,'123','https://example.test/');return false}
 catch(error){return error instanceof ChapterLinkError}
})));
""")
    assert all(data)
