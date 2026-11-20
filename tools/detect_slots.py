import sys, numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
S=400/72
f=sys.argv[1]; O=float(sys.argv[2]); ST=float(sys.argv[3]); YE=float(sys.argv[4])
a=np.array(Image.open(f'pdf/{f}.png').convert('L')).astype(int)
H,W=a.shape
y0,y1=int(215*S),int(YE*S)   # body range in pt
dark=a<90
# column borders: x where dark fraction over body > .8
colfrac=dark[y0:y1].mean(axis=0)
xs=[x for x in range(W) if colfrac[x]>0.8]
# group
borders=[]
for x in xs:
    if borders and x-borders[-1][-1]<=3: borders[-1].append(x)
    else: borders.append([x])
borders=[(b[0],b[-1]) for b in borders]
print('borders',len(borders),[round(b[0]/S,1) for b in borders])
def t(ypx):
    m=round(((ypx/S)-O)/ST*5)
    m=round(m/5)*5
    h=9*60+30+m
    return f'{h//60}:{h%60:02d}'
out=[]
for (l,r),(l2,r2) in zip(borders,borders[1:]):
    x0,x1=r+3,l2-3
    if x1-x0<40: continue
    seg=dark[int(195*S):y1+int(15*S),x0:x1]
    rowfrac=seg.mean(axis=1)
    lines=[i for i,v in enumerate(rowfrac) if v>0.85]
    g=[]
    for i in lines:
        if g and i-g[-1][-1]<=3: g[-1].append(i)
        else: g.append([i])
    ly=[(int(195*S)+(k[0]+k[-1])//2) for k in g]
    # classify segments between lines: white if mean brightness high and few gray
    gray=(a[:,x0:x1]>200)&(a[:,x0:x1]<235)
    slots=[]
    for ya,yb in zip(ly,ly[1:]):
        if yb-ya<10: continue
        inner=gray[ya+3:yb-3]
        gfrac=inner.mean()
        if gfrac<0.25: slots.append((t(ya),t(yb)))
    out.append((round(l2/S,1),slots))
    print(round(x0/S,1),round(x1/S,1),len(slots),' '.join(f'{s}-{e}' for s,e in slots))
