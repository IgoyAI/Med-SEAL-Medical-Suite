#!/usr/bin/env python3
"""Generate real multi-slice 3D DICOM studies and upload to Orthanc."""
import pydicom, numpy as np, requests, os, tempfile
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian, CTImageStorage, MRImageStorage

ORTHANC = 'http://localhost:8042'
AUTH = ('orthanc', 'orthanc')

patients = [
    {'pid': '1', 'name': 'Becker^Abe', 'dob': '20041018', 'sex': 'M'},
    {'pid': '2', 'name': 'Miller^Adam', 'dob': '19850315', 'sex': 'M'},
    {'pid': '3', 'name': 'Rodriguez^Adela', 'dob': '19720820', 'sex': 'F'},
    {'pid': '4', 'name': 'Esquivel^Adela', 'dob': '19650112', 'sex': 'F'},
    {'pid': '5', 'name': 'Aufderhar^Adeline', 'dob': '19900607', 'sex': 'F'},
    {'pid': '6', 'name': 'Wehner^Arnulfo', 'dob': '19780923', 'sex': 'M'},
    {'pid': '7', 'name': 'Hagenes^Adolfo', 'dob': '19551104', 'sex': 'M'},
    {'pid': '8', 'name': 'Funk^Aldo', 'dob': '20000214', 'sex': 'M'},
]

studies_cfg = [
    {'mod': 'CT', 'sop': CTImageStorage, 'desc': 'CT Head without contrast', 'body': 'HEAD', 'sl': 50, 'thick': 3.0, 'wc': '40', 'ww': '80'},
    {'mod': 'CT', 'sop': CTImageStorage, 'desc': 'CT Chest with contrast', 'body': 'CHEST', 'sl': 60, 'thick': 2.5, 'wc': '-600', 'ww': '1500'},
    {'mod': 'CT', 'sop': CTImageStorage, 'desc': 'CT Abdomen Pelvis', 'body': 'ABDOMEN', 'sl': 55, 'thick': 3.0, 'wc': '40', 'ww': '400'},
    {'mod': 'MR', 'sop': MRImageStorage, 'desc': 'MRI Brain with Gad', 'body': 'HEAD', 'sl': 40, 'thick': 4.0, 'wc': '500', 'ww': '1000'},
    {'mod': 'CT', 'sop': CTImageStorage, 'desc': 'CT Lumbar Spine', 'body': 'LSPINE', 'sl': 45, 'thick': 2.0, 'wc': '300', 'ww': '1500'},
    {'mod': 'MR', 'sop': MRImageStorage, 'desc': 'MRI Knee', 'body': 'KNEE', 'sl': 35, 'thick': 3.0, 'wc': '400', 'ww': '800'},
    {'mod': 'CT', 'sop': CTImageStorage, 'desc': 'CT Chest PE Protocol', 'body': 'CHEST', 'sl': 55, 'thick': 1.25, 'wc': '100', 'ww': '700'},
    {'mod': 'MR', 'sop': MRImageStorage, 'desc': 'MRI Lumbar Spine', 'body': 'LSPINE', 'sl': 30, 'thick': 4.0, 'wc': '500', 'ww': '1000'},
]

def gen_slice(rows, cols, si, total, body, mod):
    z = si / max(total - 1, 1)
    cy, cx = rows//2, cols//2
    y, x = np.ogrid[:rows, :cols]
    img = np.zeros((rows, cols), dtype=np.uint16)
    
    if body == 'HEAD':
        outer = ((x-cx)**2/(95**2) + (y-cy)**2/(110**2)) <= 1
        inner = ((x-cx)**2/(85**2) + (y-cy)**2/(100**2)) <= 1
        skull = outer & ~inner
        brain = inner
        vent = ((x-cx)**2 + (y-cy)**2) <= (15+10*np.sin(z*np.pi))**2
        if mod == 'CT':
            img[skull] = np.random.randint(1800, 2000, skull.sum()).astype(np.uint16)
            img[brain] = np.random.randint(1030, 1060, brain.sum()).astype(np.uint16)
            img[vent] = np.random.randint(1005, 1020, vent.sum()).astype(np.uint16)
        else:
            img[skull] = np.random.randint(100, 300, skull.sum()).astype(np.uint16)
            img[brain] = np.random.randint(600, 900, brain.sum()).astype(np.uint16)
            img[vent] = np.random.randint(1000, 1200, vent.sum()).astype(np.uint16)
    elif body == 'CHEST':
        body_m = ((x-cx)**2/(110**2) + (y-cy)**2/(90**2)) <= 1
        lung_l = ((x-cx+40)**2/(45**2) + (y-cy)**2/(65**2)) <= 1
        lung_r = ((x-cx-40)**2/(45**2) + (y-cy)**2/(65**2)) <= 1
        heart = ((x-cx+15)**2 + (y-cy+10)**2) <= (30+15*np.sin(z*np.pi))**2
        img[body_m] = np.random.randint(1030, 1060, body_m.sum()).astype(np.uint16)
        img[lung_l] = np.random.randint(100, 300, lung_l.sum()).astype(np.uint16)
        img[lung_r] = np.random.randint(100, 300, lung_r.sum()).astype(np.uint16)
        img[heart & body_m] = np.random.randint(1040, 1080, (heart & body_m).sum()).astype(np.uint16)
    elif body == 'ABDOMEN':
        body_m = ((x-cx)**2/(115**2) + (y-cy)**2/(95**2)) <= 1
        liver = ((x-cx-35)**2/(50**2) + (y-cy-10)**2/(40**2)) <= 1
        spleen = ((x-cx+50)**2/(20**2) + (y-cy-5)**2/(25**2)) <= 1
        spine = ((x-cx)**2 + (y-cy+40)**2) <= 12**2
        img[body_m] = np.random.randint(1020, 1050, body_m.sum()).astype(np.uint16)
        img[liver & body_m] = np.random.randint(1055, 1075, (liver & body_m).sum()).astype(np.uint16)
        img[spleen & body_m] = np.random.randint(1045, 1065, (spleen & body_m).sum()).astype(np.uint16)
        img[spine & body_m] = np.random.randint(1200, 1500, (spine & body_m).sum()).astype(np.uint16)
    else:
        body_m = ((x-cx)**2/(80**2) + (y-cy)**2/(70**2)) <= 1
        bone = ((x-cx)**2/(15**2) + (y-cy)**2/(15**2)) <= 1
        if mod == 'CT':
            img[body_m] = np.random.randint(1030, 1070, body_m.sum()).astype(np.uint16)
            img[bone] = np.random.randint(1300, 1800, bone.sum()).astype(np.uint16)
        else:
            img[body_m] = np.random.randint(300, 600, body_m.sum()).astype(np.uint16)
            img[bone] = np.random.randint(50, 150, bone.sum()).astype(np.uint16)
    
    noise = np.random.randint(0, 5, (rows, cols), dtype=np.uint16)
    return (img + noise).astype(np.uint16)

def create_and_upload(pat, cfg, study_uid, series_uid, frame_uid, si, total):
    sop_uid = generate_uid()
    fn = os.path.join(tempfile.gettempdir(), f'dcm_{si}.dcm')
    
    fm = Dataset()
    fm.MediaStorageSOPClassUID = cfg['sop']
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = generate_uid()
    
    ds = FileDataset(fn, {}, file_meta=fm, preamble=b'\x00'*128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    
    ds.PatientName = pat['name']; ds.PatientID = pat['pid']
    ds.PatientBirthDate = pat['dob']; ds.PatientSex = pat['sex']
    ds.StudyInstanceUID = study_uid; ds.SeriesInstanceUID = series_uid
    ds.SOPClassUID = cfg['sop']; ds.SOPInstanceUID = sop_uid
    ds.Modality = cfg['mod']
    ds.StudyDate = '20260310'; ds.StudyTime = '103000'
    ds.ContentDate = '20260310'; ds.ContentTime = '103000'
    ds.StudyDescription = cfg['desc']; ds.SeriesDescription = cfg['desc'] + ' Axial'
    ds.InstitutionName = 'Med-SEAL General Hospital'
    ds.Manufacturer = 'MedScan'; ds.ManufacturerModelName = 'MedScan 3000'
    ds.AccessionNumber = f'RAD3D{pat["pid"].zfill(4)}'
    ds.StudyID = '1'; ds.SeriesNumber = 1; ds.InstanceNumber = si + 1
    ds.FrameOfReferenceUID = frame_uid; ds.PositionReferenceIndicator = ''
    ds.ImagePositionPatient = ['0', '0', str(si * cfg['thick'])]
    ds.ImageOrientationPatient = ['1','0','0','0','1','0']
    ds.SliceLocation = str(si * cfg['thick'])
    ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.Rows = 256; ds.Columns = 256
    ds.PixelSpacing = ['0.5', '0.5']
    ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = '-1024' if cfg['mod'] == 'CT' else '0'
    ds.RescaleSlope = '1'
    ds.WindowCenter = cfg['wc']; ds.WindowWidth = cfg['ww']
    ds.SliceThickness = str(cfg['thick'])
    ds.BodyPartExamined = cfg['body']
    ds.PixelData = gen_slice(256, 256, si, total, cfg['body'], cfg['mod']).tobytes()
    
    ds.save_as(fn, write_like_original=False)
    with open(fn, 'rb') as f:
        r = requests.post(f'{ORTHANC}/instances', data=f.read(),
                         headers={'Content-Type': 'application/dicom'}, auth=AUTH)
    os.unlink(fn)
    return r.status_code == 200

def main():
    print('=== Generating 3D DICOM Studies ===\n')
    
    # Clear old
    for sid in requests.get(f'{ORTHANC}/studies', auth=AUTH).json():
        requests.delete(f'{ORTHANC}/studies/{sid}', auth=AUTH)
    print('Cleared old studies\n')
    
    total = 0
    for i, pat in enumerate(patients):
        cfg = studies_cfg[i % len(studies_cfg)]
        study_uid = generate_uid()
        series_uid = generate_uid()
        frame_uid = generate_uid()
        ok = 0
        print(f'📊 {pat["name"].replace("^"," ")} — {cfg["desc"]} ({cfg["sl"]} slices)')
        for s in range(cfg['sl']):
            if create_and_upload(pat, cfg, study_uid, series_uid, frame_uid, s, cfg['sl']):
                ok += 1
        print(f'  ✅ {ok}/{cfg["sl"]} uploaded')
        total += ok
    
    stats = requests.get(f'{ORTHANC}/statistics', auth=AUTH).json()
    print(f'\n=== DONE ===')
    print(f'Studies: {stats["CountStudies"]}, Instances: {stats["CountInstances"]}, Size: {stats["TotalDiskSizeMB"]}MB')

if __name__ == '__main__':
    main()
