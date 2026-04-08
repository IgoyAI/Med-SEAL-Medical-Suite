window.config = {
    routerBasename: '/',
    showStudyList: true,
    extensions: [],
    modes: [],
    customizationService: {},
    showLoadingIndicator: true,
    dangerouslyUseDynamicConfig: {
        enabled: false,
    },
    dataSources: [
        {
            namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
            sourceName: 'MedSEAL-Orthanc',
            configuration: {
                friendlyName: 'MedSEAL Orthanc PACS',
                name: 'orthanc',
                wadoUriRoot: '/wado',
                qidoRoot: '/dicom-web',
                wadoRoot: '/dicom-web',
                qidoSupportsIncludeField: false,
                supportsReject: false,
                imageRendering: 'wadors',
                thumbnailRendering: 'wadors',
                enableStudyLazyLoad: true,
                supportsFuzzyMatching: false,
                supportsWildcard: true,
                staticWado: true,
                singlepart: 'bulkdata,video',
                bulkDataURI: {
                    enabled: true,
                },
            },
        },
    ],
    defaultDataSourceName: 'MedSEAL-Orthanc',
};
